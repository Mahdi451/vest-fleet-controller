import {
  createHash,
  createPrivateKey,
  randomBytes,
  scryptSync,
  timingSafeEqual,
  X509Certificate,
} from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import {
  machineBinding,
  protectedFile,
  validateRuntimeDirectorySync,
} from '../../../packages/host/src/storage.ts';
export {
  machineBinding,
  protectedFile,
} from '../../../packages/host/src/storage.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { isAbsolute } from 'node:path';
import type { SecureContextOptions } from 'node:tls';
import { z } from 'zod';

const configurationSchema = z
  .object({
    version: z.literal(1),
    active: z.boolean().default(true),
    origin: z.string().url(),
    bindAddress: z.string(),
    port: z.number().int().min(1024).max(65535),
    ownerId: z.string().uuid(),
    instanceId: z.string().uuid(),
    runtimeDirectory: z.string(),
    machineHash: z.string().regex(/^[a-f0-9]{64}$/),
    certPath: z.string(),
    keyPath: z.string(),
    secretSalt: z.string().regex(/^[a-f0-9]{32}$/),
    secretHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type PrivateAccessConfig = z.infer<typeof configurationSchema>;
export interface AccessSession {
  ownerId: string;
  instanceId: string;
  csrf: string;
  expiresAt: number;
}
const COOKIE = '__Host-vfc';
const digest = (token: string) =>
  createHash('sha256').update(token).digest('hex');

export function secretVerifier(
  secret: string,
  salt = randomBytes(16).toString('hex'),
) {
  return {
    secretSalt: salt,
    secretHash: scryptSync(secret, Buffer.from(salt, 'hex'), 32).toString(
      'hex',
    ),
  };
}
export async function validatePrivateConfiguration(
  config: PrivateAccessConfig,
): Promise<{ cert: Buffer; key: Buffer; minVersion: 'TLSv1.2' }> {
  configurationSchema.parse(config);
  if (!config.active) throw new Error('Execution instance is revoked');
  const origin = new URL(config.origin);
  if (
    origin.protocol !== 'https:' ||
    !origin.hostname.endsWith('.ts.net') ||
    !/^[a-z0-9.-]+\.ts\.net$/.test(origin.hostname) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    origin.origin !== config.origin ||
    Number(origin.port || 443) !== config.port
  ) {
    throw new Error(
      'Private origin must be an exact HTTPS Tailscale hostname and configured port',
    );
  }
  const address = config.bindAddress.split('.').map(Number);
  if (
    address.length !== 4 ||
    address.some((n) => !Number.isInteger(n) || n < 0 || n > 255) ||
    address[0] !== 100 ||
    address[1]! < 64 ||
    address[1]! > 127
  )
    throw new Error('Private bind address must be a Tailscale IPv4 address');
  const assigned = Object.values(networkInterfaces())
    .flat()
    .some(
      (entry) =>
        entry?.family === 'IPv4' && entry.address === config.bindAddress,
    );
  if (!assigned)
    throw new Error('Private bind address is not assigned to this host');
  validateRuntimeDirectorySync(config.runtimeDirectory);
  if (
    !isAbsolute(config.runtimeDirectory) ||
    (await realpath(config.runtimeDirectory)) !== config.runtimeDirectory ||
    (await machineBinding()) !== config.machineHash
  )
    throw new Error(
      'Execution instance is bound to a different host or runtime directory',
    );
  if (!isAbsolute(config.certPath) || !isAbsolute(config.keyPath))
    throw new Error('TLS file paths must be absolute');
  const cert = await readFile(config.certPath);
  const key = await protectedFile(config.keyPath);
  return validateTls(cert, key, origin.hostname);
}
export function validateTls(
  cert: Buffer,
  key: Buffer,
  hostname: string,
  now = Date.now(),
): { cert: Buffer; key: Buffer; minVersion: 'TLSv1.2' } {
  const certificate = new X509Certificate(cert);
  if (
    !certificate.checkHost(hostname, { subject: 'never' }) ||
    now < Date.parse(certificate.validFrom) ||
    now >= Date.parse(certificate.validTo) ||
    !certificate.checkPrivateKey(createPrivateKey(key))
  )
    throw new Error(
      'TLS certificate hostname, validity, or private key does not match',
    );
  return { cert, key, minVersion: 'TLSv1.2' };
}

export async function loadPrivateAccess(path: string): Promise<PrivateAccess> {
  const config = configurationSchema.parse(
    JSON.parse((await protectedFile(path)).toString('utf8')),
  );
  const tls = await validatePrivateConfiguration(config);
  const identity = z
    .object({
      ownerId: z.string().uuid(),
      instanceId: z.string().uuid(),
      machineHash: z.string().regex(/^[a-f0-9]{64}$/),
      runtimeDirectory: z.string(),
      state: z.literal('ACTIVE'),
      legacyDatabases: z.array(z.string()).optional(),
    })
    .strict()
    .parse(
      JSON.parse(
        (
          await protectedFile(`${config.runtimeDirectory}/identity.json`)
        ).toString('utf8'),
      ),
    );
  if (
    identity.ownerId !== config.ownerId ||
    identity.instanceId !== config.instanceId ||
    identity.machineHash !== config.machineHash ||
    identity.runtimeDirectory !== config.runtimeDirectory
  )
    throw new Error(
      'Private configuration cannot reassign the provisioned execution identity',
    );
  return new PrivateAccess(config, tls);
}

/** Direct construction is for isolated tests; production must use loadPrivateAccess. */
export class PrivateAccess {
  private readonly sessions = new Map<string, AccessSession>();
  private failedAttempts = 0;
  private attemptWindow = 0;
  private readonly now: () => number;
  private readonly duration: number;
  readonly config: PrivateAccessConfig;
  readonly tls: SecureContextOptions;
  constructor(
    config: PrivateAccessConfig,
    tls: SecureContextOptions,
    options: { now?: () => number; sessionDurationMs?: number } = {},
  ) {
    this.config = Object.freeze(configurationSchema.parse(config));
    this.tls = tls;
    this.now = options.now ?? Date.now;
    this.duration = options.sessionDurationMs ?? 8 * 60 * 60 * 1000;
    if (this.duration <= 0 || this.duration > 12 * 60 * 60 * 1000)
      throw new Error('Invalid session lifetime');
  }
  validateOriginHost(req: IncomingMessage, requireOrigin = false): void {
    const url = new URL(this.config.origin);
    if (
      req.headers.host !== url.host ||
      (requireOrigin && req.headers.origin !== this.config.origin) ||
      (req.headers.origin !== undefined &&
        req.headers.origin !== this.config.origin)
    )
      throw new Error('Request host or origin is not authorized');
  }
  private cookie(req: IncomingMessage): string | undefined {
    const cookies = req.headers.cookie
      ?.split(';')
      .map((value) => value.trim())
      .filter((value) => value.startsWith(`${COOKIE}=`));
    if (cookies?.length !== 1) return undefined;
    const token = cookies[0]!.slice(COOKIE.length + 1);
    return /^[a-f0-9]{64}$/.test(token) ? token : undefined;
  }
  private prune(): void {
    for (const [key, session] of this.sessions)
      if (session.expiresAt <= this.now()) this.sessions.delete(key);
  }
  authenticate(req: IncomingMessage): AccessSession | undefined {
    this.validateOriginHost(req);
    if (!this.config.active) return undefined;
    this.prune();
    const token = this.cookie(req);
    const session = token ? this.sessions.get(digest(token)) : undefined;
    if (
      !session ||
      session.ownerId !== this.config.ownerId ||
      session.instanceId !== this.config.instanceId
    )
      return undefined;
    return { ...session };
  }
  login(secret: string, res: ServerResponse): AccessSession {
    this.prune();
    if (!this.config.active) throw new Error('Execution instance is revoked');
    if (this.now() - this.attemptWindow >= 10 * 60 * 1000) {
      this.failedAttempts = 0;
      this.attemptWindow = this.now();
    }
    if (this.failedAttempts >= 8)
      throw new Error('Sign-in temporarily unavailable');
    this.failedAttempts++;
    if (typeof secret !== 'string' || secret.length < 32 || secret.length > 256)
      throw new Error('Sign-in rejected');
    const candidate = scryptSync(
      secret,
      Buffer.from(this.config.secretSalt, 'hex'),
      32,
    );
    if (!timingSafeEqual(candidate, Buffer.from(this.config.secretHash, 'hex')))
      throw new Error('Sign-in rejected');
    if (this.sessions.size >= 32)
      throw new Error('Session limit reached; revoke sessions on the host');
    this.failedAttempts = 0;
    const token = randomBytes(32).toString('hex');
    const session = {
      ownerId: this.config.ownerId,
      instanceId: this.config.instanceId,
      csrf: randomBytes(32).toString('hex'),
      expiresAt: this.now() + this.duration,
    };
    this.sessions.set(digest(token), session);
    res.setHeader(
      'Set-Cookie',
      `${COOKIE}=${token}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(this.duration / 1000)}`,
    );
    return { ...session };
  }
  validateMutation(req: IncomingMessage, session: AccessSession): void {
    this.validateOriginHost(req, true);
    const current = this.authenticate(req);
    const token = req.headers['x-session-token'];
    if (
      !current ||
      current.ownerId !== session.ownerId ||
      current.instanceId !== session.instanceId ||
      current.csrf !== session.csrf ||
      typeof token !== 'string' ||
      !/^[a-f0-9]{64}$/.test(token) ||
      token.length !== current.csrf.length ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(current.csrf))
    )
      throw new Error('Mutation authorization rejected');
  }
  logout(req: IncomingMessage, res: ServerResponse): void {
    const token = this.cookie(req);
    if (token) this.sessions.delete(digest(token));
    this.clearCookie(res);
  }
  revokeAll(res?: ServerResponse): void {
    this.sessions.clear();
    if (res) this.clearCookie(res);
  }
  private clearCookie(res: ServerResponse): void {
    res.setHeader(
      'Set-Cookie',
      `${COOKIE}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
    );
  }
}
