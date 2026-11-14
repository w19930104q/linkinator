import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, assert, beforeAll, describe, it } from 'vitest';
import {
	check,
	LinkChecker,
	LinkState,
	type StatusCodeWarning,
} from '../src/index.js';

/**
 * Acceptance tests for the shared fetch ledger: multiple entry points and
 * recursive scans that resolve to the same final page must fetch that page
 * only once, while every seed, redirect, and skip rule keeps its own
 * traceable result row.
 */
describe('fetch ledger', () => {
	let server: http.Server;
	let rootUrl: string;
	let counts: Map<string, number>;

	const count = (key: string) => counts.get(key) ?? 0;

	beforeAll(async () => {
		server = http.createServer((req, res) => {
			const url = new URL(req.url || '/', 'http://localhost');
			const path = url.pathname;
			const docsRequest =
				path === '/~docs' || decodeURIComponent(path) === '/~docs';
			counts.set(
				docsRequest ? 'docs' : path,
				(counts.get(docsRequest ? 'docs' : path) ?? 0) + 1,
			);

			const redirect = (status: number, location: string) => {
				res.writeHead(status, { Location: location });
				res.end();
			};
			const html = (body: string, status = 200) => {
				res.writeHead(status, { 'Content-Type': 'text/html' });
				res.end(`<html><body>${body}</body></html>`);
			};

			// Site-migration sample: two legacy entry points for one document
			if (path === '/old-a' || path === '/old-b') {
				redirect(301, '/final');
				return;
			}
			if (path === '/final') {
				html('<a href="/child">child</a><h1 id="ok">Section</h1>');
				return;
			}
			if (path === '/child') {
				html('child');
				return;
			}

			// Normalized-URL sample: /~docs, /%7Edocs and a redirect to it
			if (docsRequest) {
				html('docs');
				return;
			}
			if (path === '/legacy') {
				redirect(301, '/%7Edocs');
				return;
			}

			// Circular links sample
			if (path === '/circle/') {
				html('<a href="/circle/a">a</a>');
				return;
			}
			if (path === '/circle/a') {
				html('<a href="/circle/b">b</a>');
				return;
			}
			if (path === '/circle/b') {
				html('<a href="/circle/a">a</a> <a href="/circle/b">self</a>');
				return;
			}

			// Redirect cycle across entry points
			if (path === '/x') {
				redirect(302, '/y');
				return;
			}
			if (path === '/y') {
				redirect(302, '/x');
				return;
			}

			// Fragment sample reached through a redirect
			if (path === '/') {
				html('<a href="/old-c#ok">ok</a> <a href="/old-c#missing">missing</a>');
				return;
			}
			if (path === '/old-c' || path === '/also-old-c') {
				redirect(301, '/final');
				return;
			}

			// Custom status-code policy sample
			if (path === '/warn-a' || path === '/warn-b') {
				redirect(301, '/warn-final');
				return;
			}
			if (path === '/warn-final') {
				html('warn', 203);
				return;
			}

			// Skip-rule sample
			if (path === '/skip-a' || path === '/skip-b') {
				redirect(301, '/blocked');
				return;
			}
			if (path === '/blocked') {
				html('blocked');
				return;
			}

			res.writeHead(404);
			res.end('Not Found');
		});

		await new Promise<void>((resolve, reject) => {
			server.listen(0, () => {
				const addr = server.address() as AddressInfo;
				rootUrl = `http://localhost:${addr.port}`;
				resolve();
			});
			server.on('error', reject);
		});
	});

	afterAll(() => {
		server.close();
	});

	it('fetches the final page once across entry points and keeps per-entry rows', async () => {
		counts = new Map();
		const results = await check({
			path: [`${rootUrl}/old-a`, `${rootUrl}/old-b`],
			recurse: true,
			concurrency: 1,
		});

		assert.ok(results.passed);
		// The final page and its child are each fetched exactly once.
		assert.strictEqual(count('/final'), 1, 'final page fetched once');
		assert.strictEqual(count('/old-a'), 1);
		assert.strictEqual(count('/old-b'), 1);
		assert.strictEqual(count('/child'), 1, 'child fetched once');

		// One row per entry point plus the discovered child.
		assert.strictEqual(results.links.length, 3);
		const [first, second] = results.links;
		assert.strictEqual(first.url, `${rootUrl}/old-a`);
		assert.strictEqual(first.state, LinkState.OK);
		assert.strictEqual(first.status, 200);
		assert.strictEqual(first.source, `${rootUrl}/old-a`);
		assert.strictEqual(first.finalUrl, `${rootUrl}/final`);
		assert.strictEqual(second.url, `${rootUrl}/old-b`);
		assert.strictEqual(second.state, LinkState.OK);
		assert.strictEqual(second.status, 200);
		assert.strictEqual(second.source, `${rootUrl}/old-b`);
		assert.strictEqual(second.finalUrl, `${rootUrl}/final`);

		const child = results.links.find((link) => link.url.endsWith('/child'));
		assert.ok(child);
		assert.strictEqual(child.state, LinkState.OK);
		assert.strictEqual(child.source, `${rootUrl}/old-a`);
	});

	it('fetches normalized URL spellings only once', async () => {
		counts = new Map();
		const results = await check({
			path: [`${rootUrl}/~docs`, `${rootUrl}/%7Edocs`],
			concurrency: 1,
		});

		assert.ok(results.passed);
		assert.strictEqual(count('docs'), 1, 'document fetched once');
		assert.strictEqual(results.links.length, 2);
		assert.strictEqual(results.links[0].source, `${rootUrl}/~docs`);
		assert.strictEqual(results.links[1].source, `${rootUrl}/%7Edocs`);
		assert.ok(results.links.every((link) => link.state === LinkState.OK));
	});

	it('fetches a normalized redirect target only once', async () => {
		counts = new Map();
		const results = await check({
			path: [`${rootUrl}/legacy`, `${rootUrl}/~docs`],
			concurrency: 1,
		});

		assert.ok(results.passed);
		assert.strictEqual(count('docs'), 1, 'document fetched once');
		assert.strictEqual(count('/legacy'), 1);
		const legacy = results.links.find((link) => link.url.endsWith('/legacy'));
		assert.ok(legacy);
		assert.strictEqual(legacy.state, LinkState.OK);
		assert.strictEqual(legacy.finalUrl, `${rootUrl}/%7Edocs`);
		assert.strictEqual(legacy.source, `${rootUrl}/legacy`);
	});

	it('terminates on circular links with stable result ordering', async () => {
		counts = new Map();
		const run = () =>
			check({ path: `${rootUrl}/circle/`, recurse: true, concurrency: 1 });
		const first = await run();
		const second = await run();

		assert.ok(first.passed);
		assert.ok(second.passed);
		// Each run fetches every page in the cycle exactly once.
		assert.strictEqual(count('/circle/'), 2);
		assert.strictEqual(count('/circle/a'), 2);
		assert.strictEqual(count('/circle/b'), 2);

		const shape = (result: typeof first) =>
			result.links.map((link) => ({
				url: link.url,
				status: link.status,
				state: link.state,
				parent: link.parent,
				source: link.source,
			}));
		assert.deepStrictEqual(shape(first), shape(second));
		assert.deepStrictEqual(
			first.links.map((link) => link.url),
			[`${rootUrl}/circle/`, `${rootUrl}/circle/a`, `${rootUrl}/circle/b`],
		);
	});

	it('terminates on redirect cycles across entry points', async () => {
		counts = new Map();
		const results = await check({
			path: [`${rootUrl}/x`, `${rootUrl}/y`],
			concurrency: 1,
		});

		assert.ok(!results.passed);
		assert.strictEqual(results.links.length, 2);
		assert.ok(
			results.links.every((link) => link.state === LinkState.BROKEN),
			'redirect cycle entries are broken, not hanging',
		);
		// The first entry follows the cycle up to the fetch redirect limit; the
		// second reuses the recorded outcome instead of looping again.
		assert.strictEqual(count('/x') + count('/y'), 21);
		assert.strictEqual(results.links[0].source, `${rootUrl}/x`);
		assert.strictEqual(results.links[1].source, `${rootUrl}/y`);
	});

	it('validates fragments on a final page shared across entries', async () => {
		counts = new Map();
		const results = await check({
			path: [`${rootUrl}/`, `${rootUrl}/also-old-c`],
			recurse: true,
			checkFragments: true,
			concurrency: 1,
		});

		// /final is shared by the /old-c crawl and the /also-old-c entry.
		assert.strictEqual(count('/final'), 1, 'final page fetched once');
		assert.ok(!results.passed, 'missing fragment must fail the scan');

		const brokenFragment = results.links.find((link) =>
			link.url.endsWith('/old-c#missing'),
		);
		assert.ok(brokenFragment);
		assert.strictEqual(brokenFragment.state, LinkState.BROKEN);
		assert.strictEqual(brokenFragment.parent, `${rootUrl}/`);
		assert.strictEqual(brokenFragment.source, `${rootUrl}/`);

		// The valid fragment produces no broken row.
		assert.ok(
			!results.links.some(
				(link) =>
					link.url.endsWith('/old-c#ok') && link.state === LinkState.BROKEN,
			),
		);
	});

	it('emits status-code warnings for every entry point', async () => {
		counts = new Map();
		const checker = new LinkChecker();
		const warnings: StatusCodeWarning[] = [];
		checker.on('statusCodeWarning', (warning) => {
			warnings.push(warning);
		});

		const results = await checker.check({
			path: [`${rootUrl}/warn-a`, `${rootUrl}/warn-b`],
			statusCodes: { '203': 'warn' },
			concurrency: 1,
		});

		assert.ok(results.passed);
		assert.strictEqual(count('/warn-final'), 1, 'final page fetched once');
		assert.strictEqual(warnings.length, 2);
		assert.deepStrictEqual(
			warnings.map((warning) => warning.url),
			[`${rootUrl}/warn-a`, `${rootUrl}/warn-b`],
		);
		assert.ok(
			results.links.every(
				(link) => link.state === LinkState.OK && link.status === 203,
			),
		);
	});

	it('keeps skip-rule results traceable per entry point', async () => {
		counts = new Map();
		const results = await check({
			path: [`${rootUrl}/skip-a`, `${rootUrl}/skip-b`],
			linksToSkip: ['blocked'],
			concurrency: 1,
		});

		assert.ok(results.passed);
		assert.strictEqual(count('/blocked'), 0, 'skipped target never fetched');
		assert.strictEqual(results.links.length, 2);
		assert.ok(
			results.links.every((link) => link.state === LinkState.SKIPPED),
			'each entry keeps its own skipped row',
		);
		assert.strictEqual(results.links[0].source, `${rootUrl}/skip-a`);
		assert.strictEqual(results.links[1].source, `${rootUrl}/skip-b`);
	});
});
