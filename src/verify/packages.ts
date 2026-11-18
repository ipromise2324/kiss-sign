import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PACKAGE_PINS } from './package-pins.ts';
import type { PackagePin } from './package-pins.ts';

/** A package `pnpm-lock.yaml` names: its name, its version as the lockfile writes it, and its tarball's sha512. */
export type LockedPackage = {
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  /** pnpm installs it only on the systems it names, such as one CPU. */
  readonly optional: boolean;
  readonly dependencies: readonly LockedPackage[];
};

export class LockfileError extends Error {}

type YamlMap = Map<string, YamlMap | string>;

const LINE = /^((?: {2})*)('[^']*'|"[^"]*"|[^\s'"][^:]*):(?: (.+))?$/;
const unquote = (key: string): string => (/^(['"]).*\1$/.test(key) ? key.slice(1, -1) : key);

/** The block mappings of each YAML document, as pnpm writes its lockfile: `key:` or `key: value` lines indented by two spaces. A flow value stays its text, and a list item a key `- <item>`. */
function lockDocuments(text: string): YamlMap[] {
  const documents: YamlMap[] = [];
  let stack: YamlMap[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (line === '---' || index === 0) {
      stack = [new Map()];
      documents.push(stack[0]!);
      if (line === '---') continue;
    }
    if (line.trim() === '') continue;
    const item = /^((?: {2})*)- (\S.*)$/.exec(line);
    if (item !== null && item[1]!.length / 2 === stack.length - 1) {
      stack.at(-1)!.set(`- ${item[2]}`, item[2]!);
      continue;
    }
    const match = LINE.exec(line);
    const depth = match === null ? -1 : match[1]!.length / 2;
    if (match === null || depth >= stack.length) throw new LockfileError(`pnpm-lock.yaml line ${index + 1} is not one this program reads`);
    stack.length = depth + 1;
    const value = match[3] === undefined ? new Map() : match[3];
    stack[depth]!.set(unquote(match[2]!), value);
    if (typeof value !== 'string') stack.push(value);
  }
  return documents.filter((document) => document.size > 0);
}

const mapAt = (map: YamlMap | undefined, key: string): YamlMap | undefined => {
  const value = map?.get(key);
  return value instanceof Map ? value : undefined;
};

const stringAt = (map: YamlMap | undefined, key: string): string | undefined => {
  const value = map?.get(key);
  return typeof value === 'string' ? unquote(value) : undefined;
};

/**
 * The packages the root importer's `dependencies` name in `pnpm-lock.yaml`, each with those it depends on; not its
 * `devDependencies`. The document that pins pnpm itself (`packageManagerDependencies`) is not the project's.
 */
export function lockedPackages(text: string): LockedPackage[] {
  const isEnvironment = (document: YamlMap) => mapAt(mapAt(document, 'importers'), '.')?.has('packageManagerDependencies') === true;
  const documents = lockDocuments(text).filter((document) => !isEnvironment(document));
  if (documents.length !== 1 || stringAt(documents[0], 'lockfileVersion') !== '9.0') throw new LockfileError('pnpm-lock.yaml holds no lockfileVersion 9.0 document of the project');
  const lock = documents[0]!;
  const packages = mapAt(lock, 'packages');
  const snapshots = mapAt(lock, 'snapshots');
  const made = new Map<string, LockedPackage>();
  const locked = (name: string, version: string): LockedPackage => {
    const key = `${name}@${version}`;
    const known = made.get(key);
    if (known !== undefined) return known;
    if (!/^\d+\.\d+\.\d+[^\s()]*(?:\(.+\))?$/.test(version)) throw new LockfileError(`pnpm-lock.yaml: ${name} is at ${version}, not a registry version`);
    const resolution = stringAt(mapAt(packages, `${name}@${version.replace(/\(.*$/, '')}`), 'resolution');
    const integrity = /^\{integrity: (sha512-[A-Za-z0-9+/]+={0,2})\}$/.exec(resolution ?? '')?.[1];
    if (integrity === undefined) throw new LockfileError(`pnpm-lock.yaml gives no sha512 integrity for ${key}`);
    const snapshot = snapshots?.get(key);
    if (snapshot === undefined || (typeof snapshot === 'string' && snapshot !== '{}')) throw new LockfileError(`pnpm-lock.yaml has no snapshot of ${key}`);
    const dependencies: LockedPackage[] = [];
    made.set(key, { name, version, integrity, optional: typeof snapshot !== 'string' && stringAt(snapshot, 'optional') === 'true', dependencies });
    const named = typeof snapshot === 'string' ? [] : ['dependencies', 'optionalDependencies'].flatMap((field) => [...(mapAt(snapshot, field) ?? [])]);
    for (const [child, at] of named) {
      if (typeof at !== 'string') throw new LockfileError(`pnpm-lock.yaml: ${key} names ${child} with no version`);
      dependencies.push(locked(child, unquote(at)));
    }
    return made.get(key)!;
  };
  return [...(mapAt(mapAt(mapAt(lock, 'importers'), '.'), 'dependencies') ?? new Map())].map(([name, spec]) => {
    const version = typeof spec === 'string' ? undefined : stringAt(spec, 'version');
    if (version === undefined) throw new LockfileError(`pnpm-lock.yaml names no version of ${name}`);
    return locked(name, version);
  });
}

/** Every file under `dir` by its path from `dir` with `/` between parts, hashed with sha256; anything else that is not a folder is named in `others`. */
function filesIn(dir: string): { readonly files: Map<string, string>; readonly others: string[] } {
  const files = new Map<string, string>();
  const others: string[] = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    const name = relative(dir, path).split(sep).join('/');
    if (entry.isFile()) files.set(name, createHash('sha256').update(readFileSync(path)).digest('hex'));
    else if (!entry.isDirectory()) others.push(name);
  }
  return { files, others };
}

/** What differs between the files of the folder at `dir` and the pin: each file changed, missing, added, or not a file. */
function differences(dir: string, pin: PackagePin): string[] {
  const { files, others } = filesIn(dir);
  const problems = others.map((name) => `not a file: ${name}`);
  for (const [name, sha256] of Object.entries(pin.files)) {
    const found = files.get(name);
    if (found === undefined) problems.push(`missing: ${name}`);
    else if (found !== sha256) problems.push(`changed: ${name}`);
  }
  for (const name of files.keys()) if (!Object.hasOwn(pin.files, name)) problems.push(`added: ${name}`);
  return problems.sort();
}

/**
 * Each `node_modules` folder in the folders that hold the program's code, `bin/` and `src/`. Node looks for a package
 * there before the root `node_modules`, from the folder of the file that imports it.
 */
function nestedModuleFolders(root: string): string[] {
  return ['bin', 'src'].flatMap((top) =>
    readdirSync(join(root, top), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.name === 'node_modules')
      .map((entry) => `a node_modules folder below the root: ${relative(root, join(entry.parentPath, entry.name)).split(sep).join('/')}`),
  );
}

/**
 * Each way the packages Node would load for the clone at `root` differ from their pins: each package the lockfile's
 * `dependencies` reach, found as Node resolves it from `bin/kiss-sign` or from the package that depends on it, must hold
 * exactly the files `pins` gives for its tarball's sha512, and no other `node_modules` folder may sit nearer the code. Reads only `node:` modules and the pins, so it can run before
 * any package is loaded.
 */
export function packageProblems(root: string, pins: Readonly<Record<string, PackagePin>> = PACKAGE_PINS): string[] {
  let roots: LockedPackage[];
  try {
    roots = lockedPackages(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'));
  } catch (error) {
    if (error instanceof LockfileError || (error as NodeJS.ErrnoException).code === 'ENOENT') return [error instanceof LockfileError ? error.message : 'there is no pnpm-lock.yaml'];
    throw error;
  }
  const problems = nestedModuleFolders(root);
  const checked = new Set<string>();
  const check = (pkg: LockedPackage, from: string): void => {
    const key = `${pkg.name}@${pkg.version}`;
    let found: string | undefined;
    try {
      found = findPackageJSON(pkg.name, pathToFileURL(from));
    } catch {
      found = undefined;
    }
    if (found === undefined) {
      if (!pkg.optional) problems.push(`${key}: not installed`);
      return;
    }
    try {
      const dir = realpathSync(dirname(found));
      if (checked.has(dir)) return;
      checked.add(dir);
      const pin = pins[pkg.integrity];
      if (pin === undefined) problems.push(`${key}: no pin for its tarball ${pkg.integrity}; run node scripts/pin-packages.ts ${pkg.name}@${pkg.version.replace(/\(.*$/, '')}`);
      else problems.push(...differences(dir, pin).map((problem) => `${key}: ${problem}`));
      for (const dependency of pkg.dependencies) check(dependency, join(dir, 'package.json'));
    } catch (error) {
      problems.push(`${key}: cannot read ${(error as NodeJS.ErrnoException).path ?? found}`);
    }
  };
  for (const pkg of roots) check(pkg, join(root, 'bin', 'kiss-sign'));
  return problems;
}
