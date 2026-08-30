import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  NotFoundError,
  PermissionError,
  RateLimitError,
  ValidationError
} from '../src/core/errors.js';
import { normalizePath, translateGitHubError } from '../src/github/octokitClient.js';
import { testConfig } from './fixtures.js';

const TARGET = testConfig().all[0]!;

/** The shape octokit's RequestError exposes, built from literals. */
function httpError(
  status: number,
  message = 'boom',
  headers: Record<string, string> = {}
): Error {
  return Object.assign(new Error(message), { status, response: { headers } });
}

test('a 401 is a token problem, not a missing repo', () => {
  const error = translateGitHubError(httpError(401), TARGET);

  assert.ok(error instanceof PermissionError);
  assert.match(error.message, /GITHUB_TOKEN/);
});

test('a 403 with the quota at zero is a rate limit, carrying the reset time', () => {
  // GitHub answers 403 both for "no permission" and "quota exhausted"; only
  // the headers tell them apart, and the agent needs the right advice for each.
  const resetEpochSeconds = 1_770_000_000;
  const error = translateGitHubError(
    httpError(403, 'API rate limit exceeded', {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(resetEpochSeconds)
    }),
    TARGET
  );

  assert.ok(error instanceof RateLimitError);
  assert.equal(error.resetAt?.getTime(), resetEpochSeconds * 1000);
  assert.match(error.message, new RegExp(TARGET.fullName));
});

test('a 403 without rate-limit headers is a permission problem', () => {
  const error = translateGitHubError(httpError(403, 'Forbidden'), TARGET);

  assert.ok(error instanceof PermissionError);
  assert.match(error.message, /token/i);
});

test('a 429 is a rate limit even without any header', () => {
  const error = translateGitHubError(httpError(429, 'Too Many Requests'), TARGET);

  assert.ok(error instanceof RateLimitError);
  assert.equal(error.resetAt, null);
});

test('a 404 names the repo and the path it could not find', () => {
  const error = translateGitHubError(httpError(404, 'Not Found'), TARGET, 'docs/NADA.md');

  assert.ok(error instanceof NotFoundError);
  assert.match(error.message, new RegExp(`${TARGET.fullName}/docs/NADA.md`));
});

test('a 409 means an empty repository, reported as not-found with the reason', () => {
  const error = translateGitHubError(httpError(409, 'Git Repository is empty'), TARGET);

  assert.ok(error instanceof NotFoundError);
  assert.match(error.message, /empty/);
});

test('an unmapped status becomes a fresh Error, never the raw octokit object', () => {
  // The octokit error carries the whole request, headers included; whether the
  // Authorization header is redacted there is the dependency's business, so it
  // must not escape this function.
  const original = httpError(500, 'Internal Server Error');
  const translated = translateGitHubError(original, TARGET);

  assert.notEqual(translated, original);
  assert.match(translated.message, /500/);
  assert.match(translated.message, /Internal Server Error/);
  assert.equal('response' in translated, false);
});

test('a statusless plain Error passes through untouched', () => {
  const original = new Error('socket hang up');

  assert.equal(translateGitHubError(original, TARGET), original);
});

test('normalizePath strips leading slashes and surrounding whitespace', () => {
  assert.equal(normalizePath('README.md'), 'README.md');
  assert.equal(normalizePath('/docs/a.md'), 'docs/a.md');
  assert.equal(normalizePath('///docs/a.md'), 'docs/a.md');
  assert.equal(normalizePath('  docs/a.md  '), 'docs/a.md');
});

test('normalizePath rejects an empty path', () => {
  assert.throws(() => normalizePath(''), ValidationError);
  assert.throws(() => normalizePath('   '), ValidationError);
  assert.throws(() => normalizePath('///'), ValidationError);
});

test('normalizePath rejects any ".." segment', () => {
  assert.throws(() => normalizePath('..'), ValidationError);
  assert.throws(() => normalizePath('docs/../secrets.md'), ValidationError);
  assert.throws(() => normalizePath('../README.md'), ValidationError);
});
