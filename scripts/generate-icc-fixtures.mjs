// Copyright 2026 Felix Olsson. SPDX-License-Identifier: GPL-3.0-or-later
// Development only: external CMM and PDF rasterizer are independent oracles.
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { syntheticRgbProfile, iccBlendPdf } from '../tests/pdf-engine/icc-fixture.js';

const fixtures = new URL('../tests/pdf-engine/fixtures/', import.meta.url);
await writeFile(new URL('synthetic-rgb.icc', fixtures), syntheticRgbProfile());
await writeFile(new URL('icc-blending.pdf', fixtures), iccBlendPdf());
execFileSync(process.env.PN_PYTHON || 'python', [fileURLToPath(new URL('generate-icc-oracle.py', import.meta.url))], { stdio: 'inherit' });
