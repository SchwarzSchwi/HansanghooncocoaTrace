'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
	CONFIG,
	normalizeTicker,
	isTickerStale,
	retryDelay,
	getVoices,
	selectVoice,
	makeSpeechSnapshot
} = require('../app.js');

const now = 1700000000000;
const validTicker = {
	ty: 'ticker',
	cd: 'KRW-BTC',
	tp: '52000000',
	scr: '0.0125',
	atp24h: '123456789',
	c: 'RISE',
	tms: now
};

test('normalizes valid Upbit SIMPLE ticker data', () => {
	assert.deepEqual(normalizeTicker(validTicker, now), {
		code: 'KRW-BTC',
		price: 52000000,
		signed: 0.0125,
		acc: 123456789,
		change: 'RISE',
		ts: now,
		stale: false
	});
});

test('rejects malformed, empty, unknown, and future ticker data', () => {
	assert.equal(normalizeTicker(null, now), null);
	assert.equal(normalizeTicker({}, now), null);
	assert.equal(normalizeTicker({ ...validTicker, cd: 'KRW-UNKNOWN' }, now), null);
	assert.equal(normalizeTicker({ ...validTicker, ty: 'trade' }, now), null);
	assert.equal(normalizeTicker({ ...validTicker, tp: '' }, now), null);
	assert.equal(normalizeTicker({ ...validTicker, tp: 'NaN' }, now), null);
	assert.equal(normalizeTicker({ ...validTicker, c: 'UNKNOWN' }, now), null);
	assert.equal(normalizeTicker({ ...validTicker, tms: now + 60001 }, now), null);
});

test('marks disconnected and old last-known tickers stale', () => {
	const ticker = normalizeTicker(validTicker, now);
	assert.equal(isTickerStale(ticker, now, true), false);
	assert.equal(isTickerStale({ ...ticker, ts: now + 1 }, now, true), true);
	assert.equal(isTickerStale(ticker, now, false), true);
	assert.equal(isTickerStale(ticker, now + CONFIG.staleAfterMs + 1, true), true);
	assert.equal(isTickerStale({ ...ticker, generation: 1 }, now, true, 2), true);
});

test('reconnect delay grows exponentially and is capped', () => {
	assert.deepEqual([0, 1, 2, 3].map(retryDelay), [1000, 2000, 4000, 8000]);
	assert.equal(retryDelay(20), CONFIG.reconnect.maxDelayMs);
});

test('voice helpers tolerate unsupported APIs and empty voice lists', () => {
	assert.deepEqual(getVoices(undefined), []);
	assert.deepEqual(getVoices({ getVoices: () => [] }), []);
	assert.equal(selectVoice([], ''), null);
	const voices = [
		{ name: 'English', lang: 'en-US', voiceURI: 'english' },
		{ name: 'Korean', lang: 'ko-KR', voiceURI: 'korean' }
	];
	assert.equal(selectVoice(voices).voiceURI, 'korean');
	assert.equal(selectVoice(voices, 'english').voiceURI, 'english');
});

test('speech snapshot is filtered, bounded, and identifies stale source context', () => {
	const state = new Map([
		['KRW-BTC', { ...normalizeTicker(validTicker, now), ts: now - 120000 }]
	]);
	const snapshot = makeSpeechSnapshot(CONFIG.markets, state, 'BTC', false, now);
	assert.match(snapshot, /검색|BTC|비트코인/);
	assert.match(snapshot, /지연된 마지막 데이터/);
	assert.match(makeSpeechSnapshot(CONFIG.markets, state, 'not-a-market', true, now), /검색 결과가 없습니다/);
	state.set('KRW-BTC', { ...normalizeTicker(validTicker, now), generation: 1 });
	assert.match(makeSpeechSnapshot(CONFIG.markets, state, 'BTC', true, now, 2), /지연된 마지막 데이터/);

	const allMarkets = makeSpeechSnapshot(CONFIG.markets, new Map(), '', true, now);
	assert.match(allMarkets, /나머지 11개 종목은 읽지 않았습니다/);
	assert.equal((allMarkets.match(/시세 데이터가 아직 없습니다/g) || []).length, CONFIG.maxSpeechMarkets);
});
