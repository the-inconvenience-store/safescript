import { describe, expect, it } from 'bun:test';

import {
  WorkerProtocolFrameDecoder,
  decodeWorkerProtocolEnvelope,
  decodeWorkerProtocolFrame,
  encodeWorkerProtocolEnvelope,
  encodeWorkerProtocolFrame,
  type WorkerProtocolFailureCode,
} from '@safescript/contracts';

interface WorkerProtocolManifest {
  readonly format: 1;
  readonly releaseVersion: string;
  readonly normativeDocuments: readonly string[];
  readonly index: string;
  readonly schema: string;
  readonly fixtures: string;
  readonly messageKinds: readonly string[];
}

interface WorkerProtocolFixtures {
  readonly format: 1;
  readonly releaseVersion: string;
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
    expected: Readonly<{ code: WorkerProtocolFailureCode; scope: string }>;
  }>[];
}

const repositoryRoot = new URL('../../', import.meta.url);
const manifestUrl = new URL('conformance/worker-protocol/manifest.json', repositoryRoot);
const fixturesUrl = new URL('conformance/worker-protocol/fixtures.json', repositoryRoot);

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g)?.map((pair) => Number.parseInt(pair, 16)) ?? []);
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('worker protocol publication', () => {
  it('publishes one discoverable SafeScript 0.6.0 specification surface', async () => {
    const manifest = (await Bun.file(manifestUrl).json()) as WorkerProtocolManifest;
    expect(manifest.format).toBe(1);
    expect(manifest.releaseVersion).toBe('0.6.0');
    expect(manifest.index).toBe('docs/README.md');
    expect(manifest.schema).toBe('docs/worker-protocol.cddl');
    expect(manifest.fixtures).toBe('conformance/worker-protocol/fixtures.json');
    for (const path of [manifest.index, ...manifest.normativeDocuments, manifest.schema, manifest.fixtures])
      expect(await Bun.file(new URL(path, repositoryRoot)).exists(), path).toBe(true);
  });

  it('runs every canonical vector through exact, split, and coalesced framing', async () => {
    const fixtures = (await Bun.file(fixturesUrl).json()) as WorkerProtocolFixtures;
    expect(fixtures).toMatchObject({ format: 1, releaseVersion: '0.6.0' });
    for (const fixture of fixtures.valid) {
      const frame = bytes(fixture.frameHex);
      const decodedFrame = decodeWorkerProtocolFrame(frame);
      expect(decodedFrame.ok, fixture.name).toBe(true);
      if (!decodedFrame.ok) continue;
      expect(hex(decodedFrame.value), fixture.name).toBe(fixture.envelopeHex);
      const decodedEnvelope = decodeWorkerProtocolEnvelope(decodedFrame.value);
      expect(decodedEnvelope.ok, fixture.name).toBe(true);
      if (!decodedEnvelope.ok) continue;
      expect(hex(decodedEnvelope.value.payload), fixture.name).toBe(fixture.payloadHex);
      const encodedEnvelope = encodeWorkerProtocolEnvelope(decodedEnvelope.value);
      expect(encodedEnvelope.ok, fixture.name).toBe(true);
      if (!encodedEnvelope.ok) continue;
      const encodedFrame = encodeWorkerProtocolFrame(encodedEnvelope.value);
      expect(encodedFrame.ok && hex(encodedFrame.value), fixture.name).toBe(fixture.frameHex);

      for (const splitAt of [1, 2, 3, 4, frame.length - 1]) {
        const decoder = new WorkerProtocolFrameDecoder();
        expect(decoder.push(frame.subarray(0, splitAt)), fixture.name).toEqual({ ok: true, value: [] });
        const completed = decoder.push(frame.subarray(splitAt));
        expect(completed.ok && completed.value.map(hex), fixture.name).toEqual([fixture.envelopeHex]);
        expect(decoder.finish(), fixture.name).toEqual({ ok: true, value: [] });
      }
    }

    const fixture = fixtures.valid[0];
    if (!fixture) throw new Error('missing canonical fixture');
    const frame = bytes(fixture.frameHex);
    const decoder = new WorkerProtocolFrameDecoder();
    const coalesced = new Uint8Array(frame.length * 2);
    coalesced.set(frame);
    coalesced.set(frame, frame.length);
    const completed = decoder.push(coalesced);
    expect(completed.ok && completed.value.map(hex)).toEqual([fixture.envelopeHex, fixture.envelopeHex]);
  });

  it('publishes one vector per message kind and rejects every hostile fixture', async () => {
    const [manifest, fixtures] = (await Promise.all([Bun.file(manifestUrl).json(), Bun.file(fixturesUrl).json()])) as [
      WorkerProtocolManifest,
      WorkerProtocolFixtures,
    ];
    expect(fixtures.valid.map(({ kind }) => kind).sort()).toEqual([...manifest.messageKinds].sort());
    for (const fixture of fixtures.hostile) {
      const decodedFrame = decodeWorkerProtocolFrame(bytes(fixture.inputHex));
      const result = decodedFrame.ok ? decodeWorkerProtocolEnvelope(decodedFrame.value) : decodedFrame;
      expect(result.ok ? undefined : result.failure.code, fixture.name).toBe(fixture.expected.code);
    }
  });
});
