import { Logger } from '@nestjs/common';
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { Profile } from '../../profile/profile.entity.js';
import { AdzunaSource } from './adzuna.source.js';
import { GreenhouseSource } from './greenhouse.source.js';
import { JSearchSource } from './jsearch.source.js';
import { RemotiveSource } from './remotive.source.js';
import type { JobSource } from './job-source.interface.js';
import { SourcesRegistry } from './sources.registry.js';

/** A source that answers isEnabled; nothing else is exercised here. */
function stub(name: string, enabled: boolean | (() => unknown)): JobSource {
  return {
    name,
    isEnabled: typeof enabled === 'function' ? enabled : () => enabled,
    fetch: () => Promise.resolve([]),
  } as unknown as JobSource;
}

/**
 * The registry takes its four sources positionally, so a test that only cares
 * about two pads the rest with a disabled stub rather than leaving holes.
 */
function registry(...wanted: JobSource[]): SourcesRegistry {
  const pad = stub('unused', false);
  const [jsearch, adzuna, remotive, greenhouse] = [...wanted, pad, pad, pad, pad];
  return new SourcesRegistry(
    jsearch as unknown as JSearchSource,
    adzuna as unknown as AdzunaSource,
    remotive as unknown as RemotiveSource,
    greenhouse as unknown as GreenhouseSource,
  );
}

const profile = (preferences: Record<string, unknown>) =>
  ({ id: 'p1', preferences }) as unknown as Profile;

/** The four slots the constructor takes, minus the padding `registry` added. */
const named = (status: { name: string; enabled: boolean }[]) =>
  status.filter((s) => s.name !== 'unused');

describe('SourcesRegistry.status', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers "is this source usable" without a profile', () => {
    // The dashboard has no profile to hand it, so it passes a synthetic probe.
    // A probe built as `preferences: {}` is not a valid preferences object, and
    // greenhouse read `.length` off the missing `greenhouseBoards` — which came
    // out of `map()` as a 500 for the whole overview.
    const status = registry(
      stub('jsearch', true),
      stub('greenhouse', () => true),
    ).status();

    expect(named(status)).toEqual([
      { name: 'jsearch', enabled: true },
      { name: 'greenhouse', enabled: true },
    ]);
  });

  it('keeps the rest of the list when one source throws', () => {
    // This is the page you open *because* something is broken, so one broken
    // source must not be the reason it cannot load.
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const boom = new Error('preferences.greenhouseBoards is not iterable');

    const status = registry(
      stub('jsearch', true),
      stub('greenhouse', () => {
        throw boom;
      }),
      stub('remotive', true),
    ).status();

    expect(named(status)).toEqual([
      { name: 'jsearch', enabled: true },
      { name: 'greenhouse', enabled: false },
      { name: 'remotive', enabled: true },
    ]);
  });

  it('reports a partial preferences object as having no boards', () => {
    // `preferences` is a non-null jsonb column, so a row written before a field
    // existed still loads — with that key absent.
    const source = new GreenhouseSource();

    expect(source.isEnabled(profile({ roles: ['backend'] }))).toBe(false);
    expect(source.isEnabled(profile({ greenhouseBoards: ['acme'] }))).toBe(true);
  });
});

describe('SourcesRegistry.enabledFor', () => {
  it('intersects the sources that are usable with the profile allowlist', () => {
    const names = registry(
      stub('jsearch', true),
      stub('adzuna', true),
      stub('remotive', true),
    ).enabledFor(profile({ sources: ['jsearch', 'remotive'] }));

    expect(names).toEqual(['jsearch', 'remotive']);
  });

  it('uses every usable source when the profile sets no allowlist', () => {
    const names = registry(stub('jsearch', true), stub('remotive', true)).enabledFor(
      profile({ sources: [] }),
    );

    expect(names).toEqual(['jsearch', 'remotive']);
  });
});
