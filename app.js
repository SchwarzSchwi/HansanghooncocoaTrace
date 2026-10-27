'use strict';

const CONFIG = Object.freeze({
	endpoints: Object.freeze({
		tickerWebSocket: 'wss://api.upbit.com/websocket/v1'
	}),
	markets: Object.freeze([
		{ code: 'KRW-BTC', name: '비트코인' },
		{ code: 'KRW-ETH', name: '이더리움' },
		{ code: 'KRW-XRP', name: '엑스알피' },
		{ code: 'KRW-SOL', name: '솔라나' },
		{ code: 'KRW-DOGE', name: '도지코인' },
		{ code: 'KRW-ADA', name: '에이다' },
		{ code: 'KRW-AVAX', name: '아발란체' },
		{ code: 'KRW-LINK', name: '체인링크' },
		{ code: 'KRW-DOT', name: '폴카닷' },
		{ code: 'KRW-TRX', name: '트론' },
		{ code: 'KRW-POL', name: '폴리곤' },
		{ code: 'KRW-NEAR', name: '니어' },
		{ code: 'KRW-ATOM', name: '코스모스' },
		{ code: 'KRW-APT', name: '앱토스' },
		{ code: 'KRW-STX', name: '스택스' },
		{ code: 'KRW-SUI', name: '수이' }
	]),
	reconnect: Object.freeze({
		baseDelayMs: 1000,
		maxDelayMs: 30000,
		connectTimeoutMs: 10000,
		initialDataTimeoutMs: 12000,
		stableConnectionMs: 30000
	}),
	staleAfterMs: 60000,
	maxSpeechMarkets: 5
});

const marketCodes = new Set(CONFIG.markets.map(market => market.code));

function numericValue(value) {
	if (typeof value !== 'number' && typeof value !== 'string') return null;
	if (typeof value === 'string' && !value.trim()) return null;
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

function normalizeTicker(data, now = Date.now()) {
	if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
	if (data.ty !== 'ticker' || typeof data.cd !== 'string' || !marketCodes.has(data.cd)) return null;

	const price = numericValue(data.tp);
	const signed = numericValue(data.scr);
	const acc = numericValue(data.atp24h);
	const change = data.c;
	const ts = numericValue(data.tms ?? data.ttms ?? data.timestamp);
	if (price === null || price <= 0 || signed === null || acc === null || acc < 0 ||
		!['RISE', 'FALL', 'EVEN'].includes(change) || ts === null || ts <= 0 ||
		ts > now + 60000) return null;

	return { code: data.cd, price, signed, acc, change, ts, stale: false };
}

function isTickerStale(ticker, now = Date.now(), connected = true, currentGeneration = null) {
	return !connected || (currentGeneration !== null && ticker?.generation !== currentGeneration) ||
		!Number.isFinite(ticker?.ts) || ticker.ts > now || now - ticker.ts > CONFIG.staleAfterMs;
}

function retryDelay(attempt) {
	return Math.min(CONFIG.reconnect.baseDelayMs * (2 ** Math.max(0, attempt)), CONFIG.reconnect.maxDelayMs);
}

function getVoices(synthesis) {
	if (!synthesis || typeof synthesis.getVoices !== 'function') return [];
	try {
		const voices = synthesis.getVoices();
		return Array.isArray(voices) ? voices : [];
	} catch {
		return [];
	}
}

function selectVoice(voices, selectedURI = '') {
	if (selectedURI) {
		const selected = voices.find(voice => voice.voiceURI === selectedURI);
		if (selected) return selected;
	}
	return voices.find(voice => /^ko(?:-|$)/i.test(voice.lang || '')) || voices[0] || null;
}

function makeSpeechSnapshot(markets, state, searchTerm, connected, now = Date.now(), currentGeneration = null) {
	const term = searchTerm.trim().toLocaleLowerCase('ko-KR');
	const matching = markets.filter(({ code, name }) => `${code} ${name}`.toLocaleLowerCase('ko-KR').includes(term));
	if (!matching.length) return '검색 결과가 없습니다.';

	const visible = matching.slice(0, CONFIG.maxSpeechMarkets);
	const number = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 8 });
	const date = new Intl.DateTimeFormat('ko-KR', {
		timeZone: 'Asia/Seoul',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false
	});
	const lines = visible.map(({ code, name }) => {
		const ticker = state.get(code);
		if (!ticker) return `${name}, 시세 데이터가 아직 없습니다.`;
		const stale = isTickerStale(ticker, now, connected, currentGeneration);
		const movement = Number.isFinite(ticker.signed)
			? `전일 대비 ${(ticker.signed * 100).toFixed(2)}퍼센트`
			: '전일 대비 정보 없음';
		const time = Number.isFinite(ticker.ts) ? date.format(new Date(ticker.ts)) : '미제공';
		return `${name}, ${number.format(ticker.price)}원, ${movement}, ${stale ? '지연된 마지막 데이터' : '최근 데이터'}, 원천 시각 ${time}`;
	});
	const omitted = matching.length - visible.length;
	return `연결 상태 ${connected ? '연결됨' : '연결 끊김'}. 표시 중인 종목 ${matching.length}개 중 ${visible.length}개를 읽습니다. ${lines.join('. ')}.${omitted ? ` 나머지 ${omitted}개 종목은 읽지 않았습니다.` : ''}`;
}

function initialize() {
	const state = new Map();
	const rows = document.getElementById('rows');
	const status = document.getElementById('status');
	const dataState = document.getElementById('data-state');
	const search = document.getElementById('search');
	const nowElement = document.getElementById('now');
	const voiceSelect = document.getElementById('voice-select');
	const speechRate = document.getElementById('speech-rate');
	const voiceStart = document.getElementById('voice-start');
	const voiceStop = document.getElementById('voice-stop');
	const voiceStatus = document.getElementById('voice-status');
	const priceFormat = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 8 });
	const timeFormat = new Intl.DateTimeFormat('ko-KR', {
		timeZone: 'Asia/Seoul',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false
	});
	let socket = null;
	let retryTimer = null;
	let pingTimer = null;
	let connectTimer = null;
	let initialDataTimer = null;
	let stableTimer = null;
	let staleTimer = null;
	let generation = 0;
	let retryAttempt = 0;
	let connected = false;
	let lastError = '';

	const synthesis = window.speechSynthesis;
	const Utterance = window.SpeechSynthesisUtterance;
	const speechSupported = Boolean(synthesis && typeof synthesis.speak === 'function' &&
		typeof synthesis.cancel === 'function' && typeof Utterance === 'function');
	let speechGeneration = 0;
	let speaking = false;
	let speechWatchdog = null;

	function setStatus(message, className = '') {
		status.textContent = message;
		status.className = `pill ${className}`;
	}

	function setVoiceStatus(message) {
		voiceStatus.textContent = message;
	}

	function refreshVoiceOptions() {
		if (!speechSupported) return;
		const selected = voiceSelect.value;
		const voices = getVoices(synthesis);
		voiceSelect.replaceChildren();
		const defaultOption = document.createElement('option');
		defaultOption.value = '';
		defaultOption.textContent = voices.length ? '한국어 음성 자동 선택' : '기기 기본 음성';
		voiceSelect.appendChild(defaultOption);
		voices.forEach(voice => {
			const option = document.createElement('option');
			option.value = voice.voiceURI;
			option.textContent = `${voice.name} (${voice.lang || '언어 미지정'})`;
			voiceSelect.appendChild(option);
		});
		if (voices.some(voice => voice.voiceURI === selected)) voiceSelect.value = selected;
	}

	function updateDataState(noMatches = false) {
		if (noMatches) {
			dataState.textContent = '검색 결과가 없습니다. 검색어를 바꾸어 보세요.';
			dataState.classList.remove('error');
			return;
		}
		if (lastError) {
			dataState.textContent = `${lastError} 자동 재연결을 시도합니다. 마지막 수신 데이터는 지연 상태입니다.`;
			dataState.classList.add('error');
		} else if (!connected) {
			dataState.textContent = state.size
				? '연결이 끊겼습니다. 자동 재연결을 기다리는 동안 마지막 수신 데이터를 지연으로 표시합니다.'
				: '시세 연결 중입니다. 최신 데이터를 기다리고 있습니다.';
			dataState.classList.remove('error');
		} else if (!state.size) {
			dataState.textContent = '연결되었습니다. 최신 시세 데이터를 기다리고 있습니다.';
			dataState.classList.remove('error');
		} else {
			const freshCount = [...state.values()].filter(ticker => !isTickerStale(ticker, Date.now(), connected, generation)).length;
			dataState.textContent = freshCount
				? `실시간 시세 수신 중입니다. ${freshCount}개 종목에 최근 데이터가 있습니다.`
				: '연결은 유지 중이지만 최근 시세 데이터가 없습니다. 마지막 수신값은 지연으로 표시합니다.';
			dataState.classList.remove('error');
		}
	}

	function render() {
		const term = search.value.trim().toLocaleLowerCase('ko-KR');
		const matching = CONFIG.markets.filter(({ code, name }) => `${code} ${name}`.toLocaleLowerCase('ko-KR').includes(term));
		rows.replaceChildren();
		if (!matching.length) {
			const tr = document.createElement('tr');
			const cell = document.createElement('td');
			cell.colSpan = 6;
			cell.textContent = '검색 결과가 없습니다.';
			tr.appendChild(cell);
			rows.appendChild(tr);
			updateDataState(true);
			return;
		}

		for (const { code, name } of matching) {
			const ticker = state.get(code);
			const stale = ticker ? isTickerStale(ticker, Date.now(), connected, generation) : false;
			const tr = document.createElement('tr');
			if (stale) tr.classList.add('stale');

			const marketCell = document.createElement('td');
			const strong = document.createElement('strong');
			strong.textContent = code;
			const nameLabel = document.createElement('span');
			nameLabel.className = 'sub';
			nameLabel.textContent = name;
			marketCell.append(strong, document.createElement('br'), nameLabel);
			tr.appendChild(marketCell);

			const priceCell = document.createElement('td');
			priceCell.textContent = ticker ? priceFormat.format(ticker.price) : '-';
			tr.appendChild(priceCell);

			const changeCell = document.createElement('td');
			changeCell.className = ticker?.change === 'RISE' ? 'up' : ticker?.change === 'FALL' ? 'down' : 'flat';
			changeCell.textContent = ticker ? `${ticker.signed > 0 ? '+' : ''}${(ticker.signed * 100).toFixed(2)}%` : '-';
			tr.appendChild(changeCell);

			const volumeCell = document.createElement('td');
			volumeCell.textContent = ticker ? priceFormat.format(Math.round(ticker.acc)) : '-';
			tr.appendChild(volumeCell);

			const timeCell = document.createElement('td');
			timeCell.textContent = ticker ? timeFormat.format(new Date(ticker.ts)) : '미제공';
			tr.appendChild(timeCell);

			const stateCell = document.createElement('td');
			const badge = document.createElement('span');
			badge.className = 'badge';
			badge.textContent = !ticker ? '대기' : stale ? '지연' : '정상';
			stateCell.appendChild(badge);
			tr.appendChild(stateCell);
			rows.appendChild(tr);
		}
		updateDataState();
	}

	function clearTimers() {
		clearTimeout(retryTimer);
		clearTimeout(connectTimer);
		clearTimeout(initialDataTimer);
		clearTimeout(stableTimer);
		clearInterval(pingTimer);
		clearInterval(staleTimer);
		retryTimer = connectTimer = initialDataTimer = stableTimer = pingTimer = staleTimer = null;
	}

	function markStale() {
		connected = false;
		for (const ticker of state.values()) ticker.stale = true;
		render();
	}

	function scheduleReconnect(id, message) {
		if (id !== generation || retryTimer !== null) return;
		const delay = retryDelay(retryAttempt++);
		setStatus(`재연결 대기 중 · ${Math.ceil(delay / 1000)}초 후 시도`, 'warn');
		lastError = message;
		render();
		retryTimer = setTimeout(() => {
			if (id === generation) connect(false);
		}, delay);
	}

	function fail(id, message) {
		if (id !== generation) return;
		lastError = message;
		markStale();
		const failedSocket = socket;
		socket = null;
		clearTimeout(connectTimer);
		clearTimeout(initialDataTimer);
		clearTimeout(stableTimer);
		clearInterval(pingTimer);
		clearInterval(staleTimer);
		connectTimer = initialDataTimer = stableTimer = pingTimer = staleTimer = null;
		if (failedSocket && failedSocket.readyState < 2) {
			failedSocket.onopen = failedSocket.onclose = failedSocket.onerror = failedSocket.onmessage = null;
			try {
				failedSocket.close();
			} catch {
				// A scheduled retry already owns recovery.
			}
		}
		scheduleReconnect(id, message);
	}

	function decodeMessage(data) {
		if (typeof data === 'string') return data;
		if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
		throw new Error('Unsupported ticker message');
	}

	function connect(manual = false) {
		const id = ++generation;
		clearTimers();
		if (socket) {
			const oldSocket = socket;
			socket = null;
			oldSocket.onopen = oldSocket.onclose = oldSocket.onerror = oldSocket.onmessage = null;
			try {
				oldSocket.close();
			} catch {
				// Continue with the new connection attempt.
			}
		}
		connected = false;
		if (manual) {
			retryAttempt = 0;
			lastError = '';
		}
		setStatus('연결 중…');
		render();
		if (typeof WebSocket !== 'function') {
			lastError = '이 브라우저는 WebSocket을 지원하지 않습니다.';
			setStatus('WebSocket을 지원하지 않습니다', 'err');
			render();
			return;
		}

		try {
			const currentSocket = new WebSocket(CONFIG.endpoints.tickerWebSocket);
			socket = currentSocket;
			currentSocket.binaryType = 'arraybuffer';
			connectTimer = setTimeout(() => fail(id, '연결 시간이 초과되었습니다.'), CONFIG.reconnect.connectTimeoutMs);
			currentSocket.onopen = () => {
				if (id !== generation || socket !== currentSocket) return;
				clearTimeout(connectTimer);
				connectTimer = null;
				connected = true;
				lastError = '';
				setStatus('실시간 연결됨', 'ok');
				render();
				const request = [
					{ ticket: `web-${Math.random().toString(36).slice(2, 9)}` },
					{ type: 'ticker', codes: CONFIG.markets.map(market => market.code), isOnlyRealtime: false },
					{ format: 'SIMPLE' }
				];
				try {
					currentSocket.send(JSON.stringify(request));
				} catch {
					fail(id, '시세 요청을 보내지 못했습니다.');
					return;
				}
				initialDataTimer = setTimeout(() => fail(id, '시세 데이터를 받지 못했습니다.'), CONFIG.reconnect.initialDataTimeoutMs);
				pingTimer = setInterval(() => {
					if (id !== generation || socket !== currentSocket) return;
					try {
						currentSocket.send('PING');
					} catch {
						fail(id, '연결 유지 요청에 실패했습니다.');
					}
				}, 25000);
				staleTimer = setInterval(() => {
					if (id !== generation) return;
					const changed = [...state.values()].some(ticker => ticker.stale !== isTickerStale(ticker, Date.now(), connected, generation));
					if (changed) render();
				}, 1000);
				stableTimer = setTimeout(() => {
					if (id === generation && connected) retryAttempt = 0;
				}, CONFIG.reconnect.stableConnectionMs);
			};
			currentSocket.onmessage = event => {
				if (id !== generation || socket !== currentSocket) return;
				let data;
				try {
					const text = decodeMessage(event.data);
					if (!text || text === 'PONG') return;
					data = JSON.parse(text);
				} catch {
					fail(id, '올바르지 않은 시세 응답을 받았습니다.');
					return;
				}
				if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.cd !== 'string') {
					fail(id, '올바르지 않은 시세 응답을 받았습니다.');
					return;
				}
				if (!marketCodes.has(data.cd)) return;
				const ticker = normalizeTicker(data);
				if (!ticker) {
					fail(id, '시세 응답 형식이 유효하지 않습니다.');
					return;
				}
				const previous = state.get(ticker.code);
				if (previous && ticker.ts < previous.ts) return;
				ticker.generation = id;
				ticker.stale = isTickerStale(ticker, Date.now(), connected);
				state.set(ticker.code, ticker);
				clearTimeout(initialDataTimer);
				initialDataTimer = null;
				lastError = '';
				render();
			};
			currentSocket.onerror = () => fail(id, '네트워크 오류가 발생했습니다.');
			currentSocket.onclose = () => {
				if (id !== generation || socket !== currentSocket) return;
				socket = null;
				clearTimers();
				markStale();
				scheduleReconnect(id, '연결이 종료되었습니다.');
			};
		} catch {
			socket = null;
			scheduleReconnect(id, 'WebSocket 연결을 시작하지 못했습니다.');
		}
	}

	function finishSpeech(id, message) {
		if (id !== speechGeneration) return;
		clearTimeout(speechWatchdog);
		speechWatchdog = null;
		speaking = false;
		voiceStart.disabled = !speechSupported;
		voiceStop.disabled = true;
		setVoiceStatus(message);
	}

	function stopSpeech() {
		if (!speechSupported) return;
		speechGeneration++;
		clearTimeout(speechWatchdog);
		speechWatchdog = null;
		try {
			synthesis.cancel();
		} catch {
			// Restore the controls even if the browser cannot cancel playback.
		}
		speaking = false;
		voiceStart.disabled = false;
		voiceStop.disabled = true;
		setVoiceStatus('음성 읽기를 중지했습니다.');
	}

	function startSpeech() {
		if (!speechSupported) return;
		const id = ++speechGeneration;
		clearTimeout(speechWatchdog);
		try {
			synthesis.cancel();
			const utterance = new Utterance(makeSpeechSnapshot(
				CONFIG.markets,
				state,
				search.value,
				connected,
				Date.now(),
				generation
			));
			utterance.lang = 'ko-KR';
			utterance.rate = Number(speechRate.value);
			utterance.voice = selectVoice(getVoices(synthesis), voiceSelect.value);
			utterance.onend = () => finishSpeech(id, '화면 내용 읽기를 마쳤습니다.');
			utterance.onerror = () => finishSpeech(id, '음성 읽기가 중단되었거나 오류가 발생했습니다.');
			speaking = true;
			voiceStart.disabled = true;
			voiceStop.disabled = false;
			setVoiceStatus('화면 내용을 읽고 있습니다.');
			speechWatchdog = setTimeout(() => {
				if (id !== speechGeneration) return;
				stopSpeech();
				setVoiceStatus('읽기 시간이 초과되어 중지했습니다.');
			}, 90000);
			synthesis.speak(utterance);
		} catch {
			finishSpeech(id, '이 브라우저에서 음성 읽기를 시작하지 못했습니다.');
		}
	}

	search.addEventListener('input', render);
	document.getElementById('reconnect').addEventListener('click', () => connect(true));
	voiceStart.addEventListener('click', startSpeech);
	voiceStop.addEventListener('click', stopSpeech);
	if (speechSupported) {
		refreshVoiceOptions();
		synthesis.onvoiceschanged = refreshVoiceOptions;
	} else {
		voiceSelect.disabled = true;
		speechRate.disabled = true;
		voiceStart.disabled = true;
		voiceStop.disabled = true;
		setVoiceStatus('이 브라우저는 음성 읽기를 지원하지 않습니다. 모든 시세와 상태는 화면에서 확인할 수 있습니다.');
	}
	setInterval(() => {
		nowElement.textContent = timeFormat.format(new Date());
	}, 1000);
	render();
	connect();
}

if (typeof module !== 'undefined' && module.exports) {
	module.exports = { CONFIG, normalizeTicker, isTickerStale, retryDelay, getVoices, selectVoice, makeSpeechSnapshot };
}

if (typeof document !== 'undefined') initialize();
