import type { EpisodeManifestInput, ShowConfigInput } from '../src';
import { EpisodeManifest, ShowConfig } from '../src';

export const BASE_URL = 'https://media.example.com';

export function show(overrides: Partial<ShowConfigInput> = {}): ShowConfig {
  return ShowConfig.parse({
    schemaVersion: 1,
    slug: 'example',
    status: 'live',
    title: 'Example Show',
    description: '<p>About the show</p>',
    link: 'https://example.com',
    language: 'en',
    author: 'Example Host',
    owner: { name: 'Example Host', email: 'host@example.com' },
    image: { key: 'example/cover.jpg' },
    categories: [{ text: 'Technology', sub: 'Software How-To' }],
    explicit: false,
    podcastGuid: '23f35153-ba05-5a2c-9d23-8c51b427723c',
    ...overrides,
  });
}

export function episode(overrides: Partial<EpisodeManifestInput> = {}): EpisodeManifest {
  return EpisodeManifest.parse({
    schemaVersion: 1,
    guid: 'ep-1',
    guidIsPermaLink: false,
    title: 'Episode 1',
    description: '<p>Notes & things</p>',
    pubDate: '2026-10-01T12:00:00Z',
    durationSeconds: 1800,
    enclosure: { asset: { key: 'example/abc/v1/audio.mp3' }, length: 1234, type: 'audio/mpeg' },
    updatedAt: '2026-10-01T12:00:00Z',
    ...overrides,
  });
}
