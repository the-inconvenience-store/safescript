import { describe, expect, it } from 'bun:test';

interface WorkerProtocolManifest {
  readonly protocol: Readonly<{ major: number; minor: number }>;
  readonly normativeDocuments: readonly string[];
  readonly index: string;
  readonly schema: string;
  readonly fixtures: string;
  readonly messageKinds: readonly string[];
}

interface WorkerProtocolFixtures {
  readonly schemaVersion: string;
  readonly protocol: Readonly<{ major: number; minor: number }>;
  readonly valid: readonly Readonly<{
    name: string;
    kind: string;
    frameHex: string;
    envelopeHex: string;
    payloadHex: string;
  }>[];
  readonly hostile: readonly Readonly<{
    name: string;
    inputHex: string;
    expected: Readonly<{ code: string; scope: string }>;
  }>[];
}

const repositoryRoot = new URL('../../', import.meta.url);

describe('worker protocol 1.0 publication', () => {
  it('publishes one discoverable normative specification surface', async () => {
    const manifestFile = Bun.file(new URL('conformance/worker-protocol/v1/manifest.json', repositoryRoot));
    expect(await manifestFile.exists()).toBe(true);

    const manifest = (await manifestFile.json()) as WorkerProtocolManifest;
    expect(manifest).toEqual({
      protocol: { major: 1, minor: 0 },
      index: 'docs/v2/README.md',
      normativeDocuments: [
        'docs/v2/wire-protocol.md',
        'docs/v2/handshake-and-compatibility.md',
        'docs/v2/state-machine-and-lifecycle.md',
        'docs/v2/security.md',
        'docs/v2/limits-and-failures.md',
        'docs/v2/distribution-and-sdk.md',
        'docs/v2/migration.md',
        'docs/v2/conformance.md',
      ],
      schema: 'docs/v2/worker-protocol-1.0.cddl',
      fixtures: 'conformance/worker-protocol/v1/fixtures.json',
      messageKinds: [
        'session.hello',
        'session.welcome',
        'session.incompatible',
        'bridge.check.request',
        'bridge.check.result',
        'bridge.inspect.request',
        'bridge.inspect.result',
        'bridge.execute.request',
        'bridge.execute.result',
        'bridge.cancel.request',
        'bridge.cancel.result',
        'session.close.request',
        'session.close.result',
        'action.request',
        'action.outcome',
        'protocol.error',
      ],
    });

    for (const path of [manifest.index, ...manifest.normativeDocuments, manifest.schema, manifest.fixtures])
      expect(await Bun.file(new URL(path, repositoryRoot)).exists(), path).toBe(true);
  });

  it('publishes a canonical session close request fixture', async () => {
    const fixtures = (await Bun.file(
      new URL('conformance/worker-protocol/v1/fixtures.json', repositoryRoot),
    ).json()) as WorkerProtocolFixtures;

    expect(fixtures.valid[0]).toEqual({
      name: 'session close request',
      kind: 'session.close.request',
      frameHex:
        '0000003da562696401646b696e647573657373696f6e2e636c6f73652e72657175657374677061796c6f616441a06776657273696f6e01687265706c795f746ff6',
      envelopeHex:
        'a562696401646b696e647573657373696f6e2e636c6f73652e72657175657374677061796c6f616441a06776657273696f6e01687265706c795f746ff6',
      payloadHex: 'a0',
    });
  });

  it('publishes a hostile zero-length frame fixture', async () => {
    const fixtures = (await Bun.file(
      new URL('conformance/worker-protocol/v1/fixtures.json', repositoryRoot),
    ).json()) as WorkerProtocolFixtures;

    expect(fixtures.hostile[0]).toEqual({
      name: 'zero-length frame',
      inputHex: '00000000',
      expected: { code: 'frame_length_zero', scope: 'connection' },
    });
  });

  it('publishes hostile canonical-CBOR and closed-schema fixtures', async () => {
    const fixtures = (await Bun.file(
      new URL('conformance/worker-protocol/v1/fixtures.json', repositoryRoot),
    ).json()) as WorkerProtocolFixtures;

    expect(fixtures.hostile.slice(1).map(({ name, expected }) => [name, expected.code])).toEqual([
      ['non-minimal message ID', 'noncanonical_cbor'],
      ['indefinite payload bytes', 'noncanonical_cbor'],
      ['out-of-order envelope keys', 'noncanonical_cbor'],
      ['duplicate envelope field', 'noncanonical_cbor'],
      ['unknown envelope field', 'envelope_schema'],
      ['missing envelope field', 'envelope_schema'],
      ['trailing envelope byte', 'malformed_cbor'],
      ['invalid UTF-8 kind', 'malformed_cbor'],
      ['forbidden payload tag', 'noncanonical_cbor'],
      ['frame above absolute maximum', 'frame_too_large'],
    ]);
    for (const fixture of fixtures.hostile) {
      expect(fixture.inputHex).toMatch(/^(?:[0-9a-f]{2})+$/);
      expect(fixture.expected.scope).toBe('connection');
    }
  });

  it('specifies the complete wire boundary', async () => {
    const wire = await Bun.file(new URL('docs/v2/wire-protocol.md', repositoryRoot)).text();
    for (const heading of [
      '## Normative language',
      '## Reference stdio framing',
      '## Control envelope',
      '## Deterministic CBOR profile',
      '## Typed payloads',
      '## Schema evolution',
      '## Wire failures',
    ])
      expect(wire).toContain(heading);
  });

  it('specifies fail-closed compatibility negotiation', async () => {
    const handshake = await Bun.file(new URL('docs/v2/handshake-and-compatibility.md', repositoryRoot)).text();
    for (const heading of [
      '## Bootstrap sequence',
      '## Hello payload',
      '## Selection rules',
      '## Welcome payload',
      '## Incompatibility',
      '## Independent version dimensions',
    ])
      expect(handshake).toContain(heading);
  });

  it('specifies the bidirectional lifecycle state machine', async () => {
    const lifecycle = await Bun.file(new URL('docs/v2/state-machine-and-lifecycle.md', repositoryRoot)).text();
    for (const heading of [
      '## Roles and ownership',
      '## Connection states',
      '## Bridge exchanges',
      '## Action exchanges',
      '## Cancellation',
      '## Graceful close',
      '## Worker loss and restart',
    ])
      expect(lifecycle).toContain(heading);
  });

  it('specifies the process security boundary without overstating isolation', async () => {
    const security = await Bun.file(new URL('docs/v2/security.md', repositoryRoot)).text();
    for (const heading of [
      '## Trust boundary',
      '## Host-retained authority',
      '## Mutual validation',
      '## Spawn contract',
      '## Sensitive data',
      '## Deployment hardening',
      '## Security non-goals',
    ])
      expect(security).toContain(heading);
  });

  it('keeps operational limits separate from semantic accounting', async () => {
    const limits = await Bun.file(new URL('docs/v2/limits-and-failures.md', repositoryRoot)).text();
    for (const heading of [
      '## Limit composition',
      '## Protocol limits',
      '## Flow control',
      '## Semantic resources',
      '## Operational facts',
      '## Protocol failure catalog',
      '## Failure scope',
    ])
      expect(limits).toContain(heading);
  });

  it('specifies a version-matched local worker distribution', async () => {
    const distribution = await Bun.file(new URL('docs/v2/distribution-and-sdk.md', repositoryRoot)).text();
    for (const heading of [
      '## Package set',
      '## Worker resolution',
      '## Launch behavior',
      '## Worker identity',
      '## Explicit override',
      '## TypeScript facade behavior',
      '## Supported platforms',
    ])
      expect(distribution).toContain(heading);
  });

  it('specifies the v1-to-v2 compatibility boundary', async () => {
    const migration = await Bun.file(new URL('docs/v2/migration.md', repositoryRoot)).text();
    for (const heading of [
      '## Preserved compatibility',
      '## Intentional v2 changes',
      '## Checked artifacts',
      '## Direct bridge option',
      '## Host migration checklist',
      '## Rollback and mixed versions',
    ])
      expect(migration).toContain(heading);
  });

  it('specifies adapter-neutral evidence and release gates', async () => {
    const conformance = await Bun.file(new URL('docs/v2/conformance.md', repositoryRoot)).text();
    for (const heading of [
      '## Normative artifacts',
      '## Wire corpus',
      '## State and lifecycle corpus',
      '## Semantic equivalence',
      '## Security and privacy corpus',
      '## Platform evidence',
      '## Release gates',
    ])
      expect(conformance).toContain(heading);
  });

  it('defines one CDDL payload rule for every published message kind', async () => {
    const [manifest, schema] = await Promise.all([
      Bun.file(
        new URL('conformance/worker-protocol/v1/manifest.json', repositoryRoot),
      ).json() as Promise<WorkerProtocolManifest>,
      Bun.file(new URL('docs/v2/worker-protocol-1.0.cddl', repositoryRoot)).text(),
    ]);

    for (const kind of manifest.messageKinds) {
      const rule = kind.replaceAll('.', '-');
      expect(schema, rule).toMatch(new RegExp(`^${rule} =`, 'm'));
    }
  });

  it('links the v2 surface from project documentation without broken local references', async () => {
    const [manifest, documentationIndex] = await Promise.all([
      Bun.file(
        new URL('conformance/worker-protocol/v1/manifest.json', repositoryRoot),
      ).json() as Promise<WorkerProtocolManifest>,
      Bun.file(new URL('docs/README.md', repositoryRoot)).text(),
    ]);
    expect(documentationIndex).toContain('[SafeScript v2 specification](v2/README.md)');

    const markdownPaths = [manifest.index, ...manifest.normativeDocuments];
    for (const path of markdownPaths) {
      const documentUrl = new URL(path, repositoryRoot);
      const markdown = await Bun.file(documentUrl).text();
      for (const match of markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
        const target = match[1] as string;
        if (/^(?:https?:|mailto:|#)/.test(target)) continue;
        const fileTarget = target.split('#', 1)[0] as string;
        expect(await Bun.file(new URL(fileTarget, documentUrl)).exists(), `${path} -> ${target}`).toBe(true);
      }
    }
  });
});
