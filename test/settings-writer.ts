import { writeRlmSettings } from '../src/settings.ts';

// A separate OS process uses the package API and the real SDK workspace lock.
await writeRlmSettings(process.argv[2], { model: process.argv[3] }, 'settings-peer');
