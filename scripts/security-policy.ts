import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import ts from 'typescript';

export const policyFiles = [
  'network-policy.json',
  'build-policy.json',
  'browser-policy.json',
];
const approvedPolicies = {
  'network-policy.json': {
    version: 1,
    reviewRequired: true,
    approvedOrigins: [
      'http://127.0.0.1',
      'http://localhost',
      'https://next.vestmarkets.com',
    ],
    enabledOrigins: [],
    vestApiRoutes: [],
    vestWebSocketRoutes: [],
  },
  'build-policy.json': {
    version: 1,
    mode: 'LOCKED_OFFLINE_ONLY',
    entry: 'apps/local-trading/index.ts',
    sourceFiles: ['apps/local-trading/index.ts'],
    artifactFiles: ['index.js', ...policyFiles, 'manifest.json'],
    runtimeDependencies: [],
  },
  'browser-policy.json': {
    version: 1,
    permissions: [],
    hostPermissions: [],
    extensionEnabled: false,
    automaticUpdates: false,
  },
};

export function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function readRegular(root: string, name: string): string {
  const absoluteRoot = resolve(root);
  const path = resolve(root, name);
  const delta = relative(absoluteRoot, path);
  if (!delta || isAbsolute(delta) || delta.split(/[\\/]/).includes('..'))
    throw new Error('PATH_ESCAPE');
  let parent = path;
  while (parent !== absoluteRoot) {
    if (lstatSync(parent).isSymbolicLink())
      throw new Error('SYMLINK_FORBIDDEN');
    parent = dirname(parent);
  }
  if (realpathSync(absoluteRoot) !== absoluteRoot)
    throw new Error('ROOT_SYMLINK_FORBIDDEN');
  if (!lstatSync(path).isFile()) throw new Error('REGULAR_FILE_REQUIRED');
  return readFileSync(path, 'utf8');
}

export function assertPolicy(name: string, source: string): void {
  const expected = approvedPolicies[name as keyof typeof approvedPolicies];
  if (
    !expected ||
    JSON.stringify(JSON.parse(source)) !== JSON.stringify(expected)
  ) {
    throw new Error(`UNAPPROVED_POLICY:${name}`);
  }
}

function assertSyntax(source: string): void {
  const result = ts.transpileModule(source, {
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ES2022,
    },
  });
  if (
    result.diagnostics?.some(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    )
  ) {
    throw new Error('INVALID_SYNTAX');
  }
}

// Guardrails for legacy execution sources, not a general JavaScript sandbox.
export function auditExecutionSource(
  source: string,
  file = 'fixture.ts',
  root?: string,
): void {
  assertSyntax(source);
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const forbiddenName =
    /^(fetch|XMLHttpRequest|WebSocket|sendBeacon|eval|Function|require|localStorage|sessionStorage|indexedDB|bearer|token|accessToken|refreshToken)$/i;
  const forbiddenContent =
    /withdraw|deposit|transfer|wallet|payout|promo.?code|discount|payment|purchase|analytics|telemetry|sentry|auto.?updat|download|https?:\/\/|wss?:\/\/|\/v[0-9]+\/|0x[a-f0-9]{40}\b/i;
  function visit(node: ts.Node): void {
    if (
      (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) &&
      forbiddenName.test(node.text)
    )
      throw new Error(`FORBIDDEN_CAPABILITY:${node.text}`);
    if (ts.isStringLiteralLike(node) && /^authorization$/i.test(node.text))
      throw new Error('AUTHORIZATION_HEADER_FORBIDDEN');
    if (
      (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) &&
      forbiddenContent.test(node.text)
    ) {
      throw new Error('FORBIDDEN_EXECUTION_CONTENT');
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      throw new Error('DYNAMIC_IMPORT_FORBIDDEN');
    }
    if (ts.isImportEqualsDeclaration(node))
      throw new Error('IMPORT_EQUALS_FORBIDDEN');
    if (
      ts.isImportDeclaration(node) ||
      (ts.isExportDeclaration(node) && node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier;
      if (!specifier || !ts.isStringLiteral(specifier))
        throw new Error('UNAPPROVED_EXECUTION_IMPORT');
      const name = specifier.text;
      if (name.startsWith('.')) {
        if (root) {
          const target = resolve(dirname(file), name);
          const targetName = relative(root, target).replaceAll('\\', '/');
          const sourceName = relative(root, file).replaceAll('\\', '/');
          const hostException =
            sourceName === 'packages/simulator/src/storage.ts' &&
            targetName === 'packages/host/src/storage.ts';
          if (
            !hostException &&
            !/^packages\/(core|risk-engine|execution|browser-execution|simulator)\/src\/.*\.ts$/.test(
              targetName,
            )
          )
            throw new Error('EXECUTION_IMPORT_ESCAPE');
          readRegular(root, targetName);
        } else if (name.includes('../'))
          throw new Error('EXECUTION_IMPORT_REQUIRES_ROOT');
      } else if (name === 'playwright') {
        if (
          !file
            .replaceAll('\\', '/')
            .endsWith('/packages/browser-execution/src/vest-live-page.ts') ||
          !ts.isImportDeclaration(node) ||
          !node.importClause?.isTypeOnly
        )
          throw new Error('UNAPPROVED_EXECUTION_IMPORT');
      } else if (
        ![
          'zod',
          'decimal.js',
          'node:crypto',
          'node:sqlite',
          'node:fs',
          'node:path',
        ].includes(name)
      ) {
        throw new Error('UNAPPROVED_EXECUTION_IMPORT');
      } else if (
        ['node:fs', 'node:path'].includes(name) &&
        !file
          .replaceAll('\\', '/')
          .endsWith('/packages/simulator/src/storage.ts')
      ) {
        throw new Error('UNAPPROVED_EXECUTION_IMPORT');
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
}

// Closed syntax and behavior: two immutable constants and two refusing functions.
// No imports, network, native APIs, global lookups or expression tricks are allowed.
export function assertInertModule(source: string, emitted = false): void {
  assertSyntax(source);
  const ast = ts.createSourceFile(
    emitted ? 'index.js' : 'index.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const expectedConstants = new Map([
    ['mode', 'OFFLINE_ONLY'],
    ['liveState', 'LOCKED'],
  ]);
  const expectedFunctions = new Set(['armLiveTrading', 'executeTrade']);
  for (const statement of ast.statements) {
    const modifiers = ts.canHaveModifiers(statement)
      ? ts.getModifiers(statement)
      : undefined;
    if (
      modifiers?.length !== 1 ||
      modifiers[0]?.kind !== ts.SyntaxKind.ExportKeyword
    )
      throw new Error('INERT_EXPORT_REQUIRED');
    if (ts.isVariableStatement(statement)) {
      if (
        (statement.declarationList.flags & ts.NodeFlags.BlockScoped) !==
          ts.NodeFlags.Const ||
        statement.declarationList.declarations.length !== 1
      )
        throw new Error('INERT_CONSTANT_REQUIRED');
      const declaration = statement.declarationList.declarations[0]!;
      if (
        !ts.isIdentifier(declaration.name) ||
        !declaration.initializer ||
        !ts.isStringLiteral(declaration.initializer) ||
        declaration.type ||
        expectedConstants.get(declaration.name.text) !==
          declaration.initializer.text
      )
        throw new Error('INERT_CONSTANT_INVALID');
      expectedConstants.delete(declaration.name.text);
    } else if (ts.isFunctionDeclaration(statement)) {
      if (
        !statement.name ||
        !expectedFunctions.delete(statement.name.text) ||
        statement.parameters.length ||
        statement.asteriskToken ||
        statement.typeParameters ||
        !statement.body ||
        statement.body.statements.length !== 1
      )
        throw new Error('INERT_FUNCTION_INVALID');
      if (!emitted && statement.type?.kind !== ts.SyntaxKind.NeverKeyword)
        throw new Error('INERT_REFUSAL_REQUIRED');
      if (emitted && statement.type) throw new Error('INERT_TYPE_INVALID');
      const refusal = statement.body.statements[0]!;
      if (
        !ts.isThrowStatement(refusal) ||
        !ts.isNewExpression(refusal.expression) ||
        !ts.isIdentifier(refusal.expression.expression) ||
        refusal.expression.expression.text !== 'Error' ||
        refusal.expression.typeArguments ||
        refusal.expression.arguments?.length !== 1 ||
        !ts.isStringLiteral(refusal.expression.arguments[0]!) ||
        refusal.expression.arguments[0]!.text !== 'LIVE_EXECUTION_UNAVAILABLE'
      )
        throw new Error('INERT_REFUSAL_INVALID');
    } else throw new Error('INERT_SYNTAX_FORBIDDEN');
  }
  if (expectedConstants.size || expectedFunctions.size)
    throw new Error('INERT_MODULE_INCOMPLETE');
}

export function auditRepository(root: string): void {
  for (const name of policyFiles)
    assertPolicy(name, readRegular(root, `security/${name}`));
  const entry = readRegular(root, 'apps/local-trading/index.ts');
  assertInertModule(entry);
  const productionFiles = readdirSync(join(root, 'apps/local-trading'));
  if (JSON.stringify(productionFiles) !== JSON.stringify(['index.ts']))
    throw new Error('UNAPPROVED_PRODUCTION_SOURCE');
  for (const scope of [
    'core',
    'risk-engine',
    'execution',
    'browser-execution',
    'simulator',
  ]) {
    const scan = (directory: string): void => {
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        if (lstatSync(path).isSymbolicLink())
          throw new Error('SYMLINK_FORBIDDEN');
        if (lstatSync(path).isDirectory()) scan(path);
        else if (!name.endsWith('.ts'))
          throw new Error('UNAPPROVED_EXECUTION_SOURCE');
        else
          auditExecutionSource(
            readRegular(root, relative(root, path)),
            path,
            root,
          );
      }
    };
    scan(join(root, `packages/${scope}/src`));
  }
}

export function verifyArtifact(directory: string): void {
  const expected = ['index.js', ...policyFiles, 'manifest.json'].sort();
  if (
    JSON.stringify(readdirSync(directory).sort()) !== JSON.stringify(expected)
  )
    throw new Error('UNAPPROVED_ARTIFACT_FILE');
  const manifest = JSON.parse(
    readRegular(directory, 'manifest.json'),
  ) as unknown;
  const contents = Object.fromEntries(
    expected
      .filter((name) => name !== 'manifest.json')
      .map((name) => [name, hash(readRegular(directory, name))]),
  );
  if (
    JSON.stringify(manifest) !==
    JSON.stringify({
      version: 1,
      mode: 'LOCKED_OFFLINE_ONLY',
      hashes: contents,
    })
  )
    throw new Error('ARTIFACT_HASH_MISMATCH');
  for (const name of policyFiles)
    assertPolicy(name, readRegular(directory, name));
  assertInertModule(readRegular(directory, 'index.js'), true);
}
