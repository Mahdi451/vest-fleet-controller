import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, X509Certificate, generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PrivateAccess,
  loadPrivateAccess,
  protectedFile,
  validatePrivateConfiguration,
  validateTls,
} from '../apps/dashboard/src/private-access.ts';
import { loadLocalIdentity } from '../apps/dashboard/src/identity.ts';
import { privateHost } from './fixtures/private-host.ts';

function request(headers: Record<string, string> = {}) {
  const req = new IncomingMessage(new Socket());
  req.headers = { host: 'localhost:4173', ...headers };
  return req;
}
function response() {
  return new ServerResponse(request());
}
function cookie(res: ServerResponse) {
  return String(res.getHeader('Set-Cookie')).split(';')[0]!;
}

describe('private host access boundary', () => {
  let fixture: Awaited<ReturnType<typeof privateHost>>;
  let access: PrivateAccess;
  let now: number;
  beforeAll(async () => {
    fixture = await privateHost();
  });
  afterAll(async () => {
    await fixture.dispose();
  });
  beforeEach(() => {
    now = 1_800_000_000_000;
    access = new PrivateAccess(fixture.config, fixture.tls, {
      now: () => now,
      sessionDurationMs: 60_000,
    });
  });
  it('returns no owner or account authority without a valid session', () => {
    expect(access.authenticate(request())).toBeUndefined();
    expect(
      access.authenticate(
        request({
          cookie: '__Host-vfc=forged',
          'x-forwarded-user': fixture.config.ownerId,
        }),
      ),
    ).toBeUndefined();
  });
  it('uses secure opaque cookies with fixed expiration and no secret in session response', () => {
    const res = response();
    const session = access.login(fixture.secret, res);
    expect(res.getHeader('Set-Cookie')).toMatch(
      /^__Host-vfc=[a-f0-9]{64}; Secure; HttpOnly; SameSite=Strict; Path=\/; Max-Age=60$/,
    );
    expect(session).toMatchObject({
      ownerId: fixture.config.ownerId,
      instanceId: fixture.config.instanceId,
      expiresAt: now + 60_000,
    });
    expect(JSON.stringify(session)).not.toContain(fixture.secret);
    now += 30_000;
    expect(
      access.authenticate(request({ cookie: cookie(res) }))?.expiresAt,
    ).toBe(session.expiresAt);
    now += 30_000;
    expect(
      access.authenticate(request({ cookie: cookie(res) })),
    ).toBeUndefined();
  });
  it('rejects wrong credentials and bounds failed sign-in work', () => {
    for (let i = 0; i < 8; i++)
      expect(() => access.login('wrong', response())).toThrow(
        'Sign-in rejected',
      );
    expect(() => access.login(fixture.secret, response())).toThrow(
      'temporarily unavailable',
    );
    now += 600_000;
    expect(access.login(fixture.secret, response()).ownerId).toBe(
      fixture.config.ownerId,
    );
  });
  it('requires exact Host and Origin for every mutation including sign-in', () => {
    for (const headers of [
      { origin: 'https://evil.example' },
      { host: 'evil.example', origin: fixture.config.origin },
      {},
    ])
      expect(() => access.validateOriginHost(request(headers), true)).toThrow();
    expect(() =>
      access.validateOriginHost(
        request({ origin: fixture.config.origin }),
        true,
      ),
    ).not.toThrow();
  });
  it('does not trust forwarded host, origin, or identity', () => {
    expect(() =>
      access.validateOriginHost(
        request({
          host: 'evil.example',
          'x-forwarded-host': 'localhost:4173',
          'x-forwarded-proto': 'https',
          origin: fixture.config.origin,
        }),
      ),
    ).toThrow();
  });
  it('requires live authenticated session and matching CSRF token', () => {
    const res = response();
    const session = access.login(fixture.secret, res);
    const base = { cookie: cookie(res), origin: fixture.config.origin };
    expect(() => access.validateMutation(request(base), session)).toThrow();
    expect(() =>
      access.validateMutation(
        request({ ...base, 'x-session-token': 'f'.repeat(64) }),
        session,
      ),
    ).toThrow();
    expect(() =>
      access.validateMutation(
        request({ ...base, 'x-session-token': session.csrf }),
        session,
      ),
    ).not.toThrow();
    expect(() =>
      access.validateMutation(
        request({ ...base, 'x-session-token': session.csrf }),
        { ...session, ownerId: randomUUID() },
      ),
    ).toThrow();
    expect(() =>
      access.validateMutation(
        request({ ...base, 'x-session-token': session.csrf }),
        { ...session, instanceId: randomUUID() },
      ),
    ).toThrow();
  });
  it('isolates owners and execution instances without browser-supplied identity', () => {
    const res = response();
    access.login(fixture.secret, res);
    for (const config of [
      { ...fixture.config, ownerId: randomUUID() },
      { ...fixture.config, instanceId: randomUUID() },
    ]) {
      const other = new PrivateAccess(config, fixture.tls);
      expect(
        other.authenticate(request({ cookie: cookie(res) })),
      ).toBeUndefined();
    }
  });
  it('rejects duplicate cookie ambiguity', () => {
    const res = response();
    access.login(fixture.secret, res);
    expect(
      access.authenticate(
        request({ cookie: `${cookie(res)}; ${cookie(res)}` }),
      ),
    ).toBeUndefined();
  });
  it('logout revokes only that session and clears its cookie', () => {
    const first = response(),
      second = response();
    access.login(fixture.secret, first);
    access.login(fixture.secret, second);
    const out = response();
    access.logout(request({ cookie: cookie(first) }), out);
    expect(
      access.authenticate(request({ cookie: cookie(first) })),
    ).toBeUndefined();
    expect(
      access.authenticate(request({ cookie: cookie(second) })),
    ).toBeDefined();
    expect(out.getHeader('Set-Cookie')).toContain('Max-Age=0');
  });
  it('revokes all sessions and invalidates them across server restart', () => {
    const res = response();
    access.login(fixture.secret, res);
    const req = request({ cookie: cookie(res) });
    expect(
      new PrivateAccess(fixture.config, fixture.tls).authenticate(req),
    ).toBeUndefined();
    access.revokeAll();
    expect(access.authenticate(req)).toBeUndefined();
  });
  it('rejects a revoked execution instance', () => {
    const revoked = new PrivateAccess(
      { ...fixture.config, active: false },
      fixture.tls,
    );
    expect(revoked.authenticate(request())).toBeUndefined();
    expect(() => revoked.login(fixture.secret, response())).toThrow('revoked');
  });
  it('does not allow callers to mutate authenticated authority', () => {
    const res = response();
    const session = access.login(fixture.secret, res);
    session.ownerId = randomUUID();
    expect(access.authenticate(request({ cookie: cookie(res) }))?.ownerId).toBe(
      fixture.config.ownerId,
    );
  });
  it('requires owner-only regular configuration and keys', async () => {
    const path = join(fixture.directory, 'permission-check.json');
    await writeFile(path, '{}', { mode: 0o600 });
    expect((await protectedFile(path)).toString()).toBe('{}');
    await chmod(path, 0o644);
    await expect(protectedFile(path)).rejects.toThrow('owner-only');
  });
  it('production loader rejects localhost even though tests use isolated TLS', async () => {
    const path = join(fixture.directory, 'config.json');
    await writeFile(path, JSON.stringify(fixture.config), { mode: 0o600 });
    await expect(loadPrivateAccess(path)).rejects.toThrow('Tailscale');
    await expect(
      validatePrivateConfiguration({ ...fixture.config, active: false }),
    ).rejects.toThrow('revoked');
  });
  it('checks certificate SAN, expiry and key match independently of production network', () => {
    const cert = fixture.tls.cert,
      key = fixture.tls.key;
    expect(validateTls(cert, key, 'localhost').minVersion).toBe('TLSv1.2');
    expect(() => validateTls(cert, key, 'other.ts.net')).toThrow(
      'does not match',
    );
    const certificate = new X509Certificate(cert);
    expect(() =>
      validateTls(cert, key, 'localhost', Date.parse(certificate.validTo)),
    ).toThrow('does not match');
    expect(() =>
      validateTls(
        cert,
        key,
        'localhost',
        Date.parse(certificate.validFrom) - 1,
      ),
    ).toThrow('does not match');
    const different = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    expect(() =>
      validateTls(cert, Buffer.from(different), 'localhost'),
    ).toThrow('does not match');
  });
  it('rejects copied identities and refuses to invent identity beside durable records', async () => {
    const source = join(fixture.directory, 'binding-source'),
      destination = join(fixture.directory, 'binding-destination');
    await loadLocalIdentity(source);
    await loadLocalIdentity(destination);
    await writeFile(
      join(destination, 'identity.json'),
      await readFile(join(source, 'identity.json')),
    );
    await expect(loadLocalIdentity(destination)).rejects.toThrow(
      'different host or runtime',
    );
    const missing = join(fixture.directory, 'missing-identity');
    await mkdir(missing, { mode: 0o700 });
    await writeFile(join(missing, 'existing.sqlite'), 'preserved');
    await expect(loadLocalIdentity(missing)).rejects.toThrow(
      'operator recovery',
    );
    expect(await readFile(join(missing, 'existing.sqlite'), 'utf8')).toBe(
      'preserved',
    );
  });
  it('persists one local identity and fails closed on malformed identity', async () => {
    const path = join(fixture.directory, 'identity-runtime');
    const identities = await Promise.all([
      loadLocalIdentity(path),
      loadLocalIdentity(path),
    ]);
    expect(identities[0]).toEqual(identities[1]);
    expect(await loadLocalIdentity(path)).toEqual(identities[0]);
    await writeFile(join(path, 'identity.json'), '{}');
    await expect(loadLocalIdentity(path)).rejects.toThrow();
    expect(await readFile(join(path, 'identity.json'), 'utf8')).toBe('{}');
  });
});
