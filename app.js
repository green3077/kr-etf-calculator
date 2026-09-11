const TAX_RATE = 0.154; // 배당소득세(14%) + 지방소득세(1.4%)
const TOTAL_SCREENS = 3; // 1: 종목선택, 2: 보유수량+분배금 확인(통합), 3: 결과
const JINA_PROXY = 'https://r.jina.ai/';
// 네이티브 앱(Capacitor)에서는 CapacitorHttp가 fetch/XHR을 네이티브 쪽으로 우회시켜 브라우저
// CORS 제약이 아예 적용되지 않는다 — 그래서 시세/분배금 조회를 jina 프록시(페이지 렌더링까지
// 거쳐 요청당 수 초씩 걸림) 없이 각 공식 API에 직접 꽂아 몇 배 빠르게 만들 수 있다. 브라우저에서
// 열어 개발/미리보기할 때만 예전처럼 jina를 거친다.
const IS_NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

let currentScreen = 1;
let selectedStock = null;
let quote = null; // { price, diff, pct, date }
let distList = null; // 선택된 종목의 월별 분배 내역 (최신순), fetchDistribution()의 정규화된 결과
const quoteCache = {}; // code -> { price, diff, pct } (종목 리스트에서 미리 조회해둔 값, 선택 시 재사용)
const distCache = {}; // code -> 분배 내역 배열 (종목 리스트에서 미리 조회해둔 값, 선택 시 재사용)

// ---------- 업데이트 확인 ----------
// 사이드로드 앱은 스스로를 조용히 덮어쓸 수 없으므로(설치는 항상 사용자 확인 필요),
// 새 버전이 있으면 외부 브라우저로 APK 다운로드 URL을 열어 다운로드->설치를 대신 시작해준다.
const APP_VERSION_CODE = 8;
const APP_VERSION_NAME = "1.7";
const UPDATE_MANIFEST_URL = "https://green3077.github.io/kr-etf-calculator/version.json";
const IS_NATIVE_UPDATE = IS_NATIVE;
const UpdateBridge = IS_NATIVE_UPDATE ? window.Capacitor.registerPlugin("UpdateBridge") : null;
let pendingApkUrl = null;

document.getElementById("btnCheckUpdate").addEventListener("click", async () => {
  const btn = document.getElementById("btnCheckUpdate");
  const status = document.getElementById("updateStatus");
  if (pendingApkUrl) {
    if (IS_NATIVE_UPDATE && UpdateBridge) {
      UpdateBridge.openExternal({ url: pendingApkUrl }).catch(() => {
        status.textContent = "업데이트 파일을 여는 데 실패했습니다.";
      });
    } else {
      window.open(pendingApkUrl, "_blank");
    }
    return;
  }
  status.textContent = "업데이트 확인 중...";
  try {
    const res = await fetch(UPDATE_MANIFEST_URL + "?t=" + Date.now());
    const info = await res.json();
    if (!info || typeof info.versionCode !== "number") {
      status.textContent = "업데이트 정보를 확인하지 못했습니다.";
      return;
    }
    if (info.versionCode <= APP_VERSION_CODE) {
      status.textContent = "이미 최신 버전입니다 (v" + APP_VERSION_NAME + ")";
      return;
    }
    pendingApkUrl = info.apkUrl;
    btn.textContent = "새 버전(" + (info.versionName || info.versionCode) + ") 다운로드하기";
    status.textContent = "다시 눌러서 다운로드를 시작하세요.";
  } catch (e) {
    status.textContent = "업데이트 확인에 실패했습니다. 네트워크를 확인해주세요.";
  }
});

// ---------- 사용자가 직접 추가한 종목 (localStorage에 저장, 기본 7종목과 별개) ----------
// 어떤 운용사 API를 써야 할지 모르니 dist 소스는 없음 — 화면 3에서 자동으로 수동 입력으로 대체된다.
const CUSTOM_STOCKS_KEY = 'kretf_custom_stocks';

function loadCustomStocks() {
  try {
    const raw = localStorage.getItem(CUSTOM_STOCKS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function saveCustomStocks(list) {
  localStorage.setItem(CUSTOM_STOCKS_KEY, JSON.stringify(list));
}

let customStocks = loadCustomStocks();

function allStocks() {
  return STOCKS.concat(customStocks);
}

// 자동조회가 안 되는 커스텀 종목은 화면2에서 사용자가 직접 세전 분배금을 입력할 수 있는데(기존
// 기능), 그 값을 localStorage에 종목별로 저장해뒀다가 화면1 목록에도 "월배당금(직접입력)"으로
// 계속 보여준다 — 자동조회 종목이 아니라도 한 번 입력하면 리스트에서 계속 보이게 하기 위함.
const MANUAL_DIST_KEY = 'kretf_manual_dist';
function loadManualDist() {
  try {
    return JSON.parse(localStorage.getItem(MANUAL_DIST_KEY) || '{}');
  } catch (e) {
    return {};
  }
}
function saveManualDistValue(code, amount) {
  manualDist[code] = amount;
  localStorage.setItem(MANUAL_DIST_KEY, JSON.stringify(manualDist));
}
let manualDist = loadManualDist();

// 표준 ISIN 체크섬 규칙(ISO 6166, Luhn) — 미래에셋(TIGER) 종목은 ksdFund가 곧 종목코드로부터
// 계산되는 ISIN(KR7+코드+00+체크digit)이라는 걸 기존 2개 종목(472150→KR7472150002,
// 0177R0→KR70177R0000)으로 역산해 확인했고, 별도 종목(441680)의 실제 분배 API 호출로도
// 재검증함 — 그래서 TIGER 종목은 운용사 내부 ID를 몰라도 종목코드만으로 자동조회가 가능하다.
function computeKrIsin(code) {
  const base11 = 'KR7' + code.toUpperCase().padEnd(6, '0') + '00';
  let numeric = '';
  for (const ch of base11) {
    numeric += /[A-Z]/.test(ch) ? (ch.charCodeAt(0) - 55).toString() : ch;
  }
  let sum = 0;
  let dbl = true;
  for (let i = numeric.length - 1; i >= 0; i--) {
    let d = numeric.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return base11 + ((10 - (sum % 10)) % 10);
}

const ISSUER_LABELS = {
  mirae: '미래에셋자산운용',
  samsung: '삼성자산운용',
  sol: '신한자산운용',
  ace: '한국투자신탁운용',
  rise: 'KB자산운용',
};

// TIGER 외 4개 운용사도 ISIN 계산 같은 "공식"은 없지만, 각 사이트를 직접 뒤져서 실제 상품검색
// API를 찾아냈다 — 기존 7종목의 내부ID를 그 자리에서 다시 조회해 결과가 정확히 일치하는 것까지
// 확인함. 종목코드/이름으로 실시간 검색해서 내부ID를 얻으므로 KNOWN_CUSTOM_DIST처럼 미리 목록에
// 등록해둘 필요가 없다.

// 삼성자산운용(KODEX) 공식 상품검색 API — srchVal에 정확한 종목코드를 넣으면 그 종목만 온다.
async function findSamsungDist(code) {
  const text = await fetchText(`https://www.samsungfund.com/api/v1/kodex/product.do?srchTerm=w&srchVal=${code}&ordrColm=NAV&ordrSort=DESC&pageNo=1`);
  const json = JSON.parse(text.slice(text.indexOf('[')));
  const hit = json.find((it) => it.stkTicker === code);
  return hit ? { type: 'samsung', id: hit.fId } : null;
}

// 신한자산운용(SOL) 공식 검색 API — 종목코드로는 매치가 안 되고 이름(브랜드명 포함 전체)으로
// 검색해야 한다(실측 확인). ETF_CD6이 우리 종목코드와 일치하는 항목의 FUND_CD를 쓴다.
async function findSolDist(code, name) {
  const text = await fetchText(`https://www.soletf.com/api/etf/pds/search?keyword=${encodeURIComponent(name)}`);
  const json = JSON.parse(text.slice(text.indexOf('{')));
  const hit = (json.items || []).find((it) => it.ETF_CD6 === code);
  return hit ? { type: 'sol', fundCd: hit.FUND_CD } : null;
}

// 한국투자신탁운용(ACE) 전체 상품 목록 API — size를 총 상품수(현재 111개)보다 크게 주면
// 페이지네이션 없이 한 번에 다 온다. stockCd가 표준 ISIN이라 computeKrIsin(code)과 정확히
// 일치하는 항목을 찾는다.
async function findAceDist(code) {
  const text = await fetchText('https://papi.aceetf.co.kr/api/funds?size=300');
  const json = JSON.parse(text.slice(text.indexOf('{')));
  const isin = computeKrIsin(code);
  const hit = (json.data || []).find((it) => it.stockCd === isin);
  return hit ? { type: 'ace', fundCode: hit.fundCd } : null;
}

// KB자산운용(RISE) 실제 상품검색 AJAX(POST/GET 둘 다 됨) — searchText에 종목코드를 넣으면
// 상세페이지 링크(/prod/finderDetail/{slug})가 결과 HTML에 그 상품 하나만 남는다.
async function findRiseDist(code) {
  const text = await fetchText(`https://www.riseetf.co.kr/prod/finder/listJquery?searchText=${code}&page=1&searchOrder=&searchBoardType=&searchFieldType=`, 'jina');
  const m = text.match(/finderDetail\/([A-Za-z0-9]+)/);
  return m ? { type: 'rise', slug: m[1] } : null;
}

// 종목명의 브랜드 접두어로 운용사를 판별해 해당 운용사의 실시간 검색으로 dist를 얻는다.
// 5개 브랜드(TIGER/KODEX/SOL/ACE/RISE) 중 어디에도 안 걸리거나, 검색이 실패/미발견이면
// null — 화면2의 기존 수동입력 폴백으로 자연스럽게 넘어간다.
async function deriveKnownDist(code, name) {
  try {
    if (/^TIGER\s/i.test(name)) return { type: 'mirae', ksdFund: computeKrIsin(code), jongCode: code };
    if (/^KODEX\s/i.test(name)) return await findSamsungDist(code);
    if (/^SOL\s/i.test(name)) return await findSolDist(code, name);
    if (/^ACE\s/i.test(name)) return await findAceDist(code);
    if (/^RISE\s/i.test(name)) return await findRiseDist(code);
  } catch (e) {
    // 조용히 무시하고 null 반환 — 아래에서 수동입력 폴백으로 처리됨.
  }
  return null;
}

// ---------- 종목명 검색 (네이버 전체 국내 ETF 목록) ----------
let etfListCache = null;
async function fetchEtfList() {
  if (etfListCache) return etfListCache;
  const text = await fetchText('https://finance.naver.com/api/sise/etfItemList.nhn');
  const json = JSON.parse(text.slice(text.indexOf('{')));
  etfListCache = (json.result && json.result.etfItemList) || [];
  return etfListCache;
}

// 편집거리(레벤슈타인) — "koex"처럼 오타 섞인 단어도 "kodex"에 근접한 걸로 인정해 찾을 수 있게.
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

// 검색어 토큰 하나가 종목명의 어느 한 단어와 "근접"한지 — 부분 문자열이면 바로 인정하고,
// 아니면 편집거리로 오타 한두 글자까지 허용한다(짧은 단어는 1글자, 4글자 넘으면 2글자까지).
function fuzzyTokenMatches(token, nameWords) {
  return nameWords.some((w) => {
    if (w.includes(token) || token.includes(w)) return true;
    const maxDist = token.length > 4 ? 2 : 1;
    return levenshtein(token, w) <= maxDist;
  });
}

// 검색어를 공백 기준으로 쪼개 각 단어가 종목명에 (정확히든 근접하게든) 다 있으면 매치로 본다 —
// 예: "koex 미국" -> "KODEX 미국배당커버드콜액티브"("kodex"="koex" 편집거리1, "미국"은 그대로 포함).
async function searchEtfByName(query) {
  const list = await fetchEtfList();
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  return list
    .filter((item) => {
      const nameLower = item.itemname.toLowerCase();
      const nameWords = nameLower.split(/\s+/);
      return tokens.every((tok) => nameLower.includes(tok) || fuzzyTokenMatches(tok, nameWords));
    })
    .slice(0, 20)
    .map((item) => ({ code: item.itemcode, name: item.itemname }));
}

// 국내 ETF 검색 + 미국주식 검색을 한 번에 합쳐서 보여준다 — 한쪽이 실패해도(네트워크 등)
// 나머지 결과는 정상적으로 보여야 하므로 Promise.allSettled로 개별 실패를 흡수한다.
async function searchAllStocks(query) {
  const [krResult, usResult] = await Promise.allSettled([
    searchEtfByName(query),
    searchUsStocks(query),
  ]);
  const kr = krResult.status === 'fulfilled' ? krResult.value : [];
  const us = usResult.status === 'fulfilled' ? usResult.value : [];
  return kr.concat(us).slice(0, 20);
}

// ---------- 미국 주식 검색/시세 (세금계산 없이 검색+시세만 — 국내 ETF의 옵션/배당 재원분리
// 세금모델이 미국주식엔 애초에 적용되지 않아 dist는 항상 null로 두고 기존 수동입력 폴백에 맡긴다) ----------
// quote.price는 화면 전반의 formatKRW 기반 보유평가금액 계산이 그대로 재사용되도록 원화 환산값을
// 넣어두고, 원래 USD 값은 quote.usdPrice/usdDiff에 별도 보관해 표시에만 쓴다.
let fxRateCache = null;
async function fetchFxRate() {
  if (fxRateCache) return fxRateCache;
  const text = await fetchText('https://api.stock.naver.com/marketindex/exchange/FX_USDKRW/prices?page=1&pageSize=1');
  const json = JSON.parse(text.slice(text.indexOf('[')));
  fxRateCache = parseFloat(json[0].closePrice.replace(/,/g, ''));
  return fxRateCache;
}

// Yahoo Finance 검색 API — 미국 주요 거래소(나스닥/뉴욕/아멕스/BATS) 종목만 남긴다(그 외 국가
// 거래소도 같은 회사명으로 섞여 나오는 걸 실측으로 확인했음, 예: "apple" 검색 시 독일 상장분도 포함).
const US_EXCHANGES = ['NMS', 'NYQ', 'NGM', 'NCM', 'ASE', 'BTS', 'PCX'];
async function searchUsStocks(query) {
  const text = await fetchText(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=8&newsCount=0`);
  const json = JSON.parse(text.slice(text.indexOf('{')));
  const quotes = json.quotes || [];
  return quotes
    .filter((q) => (q.quoteType === 'EQUITY' || q.quoteType === 'ETF') && US_EXCHANGES.includes(q.exchange))
    .slice(0, 8)
    .map((q) => ({ code: q.symbol, name: q.longname || q.shortname || q.symbol, market: 'US' }));
}

async function fetchUsQuote(symbol) {
  const text = await fetchText(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`);
  const json = JSON.parse(text.slice(text.indexOf('{')));
  const result = json.chart && json.chart.result && json.chart.result[0];
  const meta = result && result.meta;
  if (!meta || typeof meta.regularMarketPrice !== 'number') throw new Error('시세 조회 실패');
  const usdPrice = meta.regularMarketPrice;
  const prevClose = meta.previousClose || meta.chartPreviousClose || usdPrice;
  const usdDiff = usdPrice - prevClose;
  const pct = prevClose ? (usdDiff / prevClose) * 100 : 0;
  const rate = await fetchFxRate();
  return {
    price: usdPrice * rate,
    diff: usdDiff * rate,
    pct: Number(pct.toFixed(2)),
    usdPrice,
    usdDiff: Number(usdDiff.toFixed(2)),
    name: meta.longName || meta.shortName || symbol,
  };
}

async function fetchQuoteForStock(stock) {
  if (stock.market === 'US') return await fetchUsQuote(stock.code);
  return await fetchQuote(stock.code);
}

function formatQuotePrice(q) {
  if (q.usdPrice != null) return `$${q.usdPrice.toFixed(2)}`;
  return formatKRW(q.price);
}

function formatHoldingValue(shares, q) {
  if (q.usdPrice != null) {
    return `$${(shares * q.usdPrice).toFixed(2)} (${formatKRW(shares * q.price)})`;
  }
  return formatKRW(shares * q.price);
}

const els = {
  ptrIndicator: document.getElementById('ptrIndicator'),
  stockList: document.getElementById('stockList'),
  quoteStatus: document.getElementById('quoteStatus'),
  btnShowAddStock: document.getElementById('btnShowAddStock'),
  stockAddForm: document.getElementById('stockAddForm'),
  customCodeInput: document.getElementById('customCodeInput'),
  btnConfirmAddStock: document.getElementById('btnConfirmAddStock'),
  addStockStatus: document.getElementById('addStockStatus'),
  stockSearchResults: document.getElementById('stockSearchResults'),
  sharesTitle: document.getElementById('sharesTitle'),
  sharesSub: document.getElementById('sharesSub'),
  shares: document.getElementById('shares'),
  holdingCard: document.getElementById('holdingCard'),
  totalValue: document.getElementById('totalValue'),
  divTitle: document.getElementById('divTitle'),
  divPerUnit: document.getElementById('divPerUnit'),
  divStatus: document.getElementById('divStatus'),
  splitCard: document.getElementById('splitCard'),
  splitOption: document.getElementById('splitOption'),
  splitDividend: document.getElementById('splitDividend'),
  manualDivBlock: document.getElementById('manualDivBlock'),
  payDateStatus: document.getElementById('payDateStatus'),
  resultTitle: document.getElementById('resultTitle'),
  resultSubtitle: document.getElementById('resultSubtitle'),
  metaShares: document.getElementById('metaShares'),
  metaTotalValue: document.getElementById('metaTotalValue'),
  preTaxKrw: document.getElementById('preTaxKrw'),
  splitRow: document.getElementById('splitRow'),
  splitDetail: document.getElementById('splitDetail'),
  splitDetailPerShare: document.getElementById('splitDetailPerShare'),
  taxRow: document.getElementById('taxRow'),
  taxKrw: document.getElementById('taxKrw'),
  postTaxKrw: document.getElementById('postTaxKrw'),
  postTaxLabel: document.getElementById('postTaxLabel'),
  unsupportedNote: document.getElementById('unsupportedNote'),
  yearlyBlock: document.getElementById('yearlyBlock'),
  yearlyTitle: document.getElementById('yearlyTitle'),
  yearlyList: document.getElementById('yearlyList'),
  yearlySummary: document.getElementById('yearlySummary'),
  navButtons: document.getElementById('navButtons'),
  btnPrev: document.getElementById('btnPrev'),
  btnNext: document.getElementById('btnNext'),
};

function formatKRW(n) {
  return Math.round(n).toLocaleString('ko-KR') + '원';
}

// 무료 jina 프록시/일부 운용사 API가 가끔 일시적으로 실패하는 걸 확인해서(사용자 리포트:
// "됐다 안됐다 한다"), 재시도 없이 바로 실패 처리하던 걸 지수 백오프로 최대 2번 더 재시도하게 함.
async function withRetry(fn, retries = 2, delayMs = 500) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < retries) await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw lastErr;
}

// jina 무료 프록시는 API 키 없이는 분당 요청 수가 낮게 제한되어 있다(공식 기준 대략 분당 20회).
// 네이티브 앱은 대부분의 호출이 이제 jina를 아예 안 거치지만(CapacitorHttp 직접 호출), RISE
// 교차검증과 브라우저 미리보기 폴백은 여전히 jina를 쓰므로, 그 두 경로가 몰릴 때 한도를 넘겨
// 한꺼번에 실패하는 걸 막기 위해 jina로 나가는 요청만 하나의 큐로 모아 최소 간격을 두고
// 순차 전송한다.
const PROXY_MIN_INTERVAL_MS = 3200; // 분당 대략 18~19회로 제한(20회 한도에 여유를 둠)
let proxyQueue = Promise.resolve();
let lastProxyCallAt = 0;

function scheduleProxyCall(fn) {
  const run = proxyQueue.then(async () => {
    const wait = lastProxyCallAt + PROXY_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastProxyCallAt = Date.now();
    return fn();
  });
  // 이 호출이 실패해도 큐 자체는 계속 이어지도록 실패를 흡수한 체인을 유지한다.
  proxyQueue = run.catch(() => {});
  return run;
}

// mode: 'auto'(기본) — 네이티브 앱이면 직접 fetch(CORS 우회, 큐 없이 바로), 브라우저면 jina 프록시(큐 경유).
//       'direct' — CORS가 열려있는 API라 브라우저에서도 항상 직접 fetch(큐 없음).
//       'jina'   — 응답이 무겁거나(RISE 상세페이지) 파싱이 jina 렌더링 형식에 맞춰져 있어 항상 jina 경유(큐 경유).
async function fetchText(url, mode = 'auto') {
  const useJina = mode === 'jina' || (mode === 'auto' && !IS_NATIVE);
  const target = useJina ? JINA_PROXY + url : url;
  const rawFetch = async () => {
    const res = await fetch(target);
    if (!res.ok) throw new Error('조회 실패');
    return res.text();
  };
  // jina로 나가는 요청만 큐를 거친다 — 네이티브 직접 호출은 공용 프록시 레이트리밋과 무관하므로
  // 재시도할 때마다 대기를 물릴 필요가 없다.
  return withRetry(() => (useJina ? scheduleProxyCall(rawFetch) : rawFetch()));
}

// ---------- 시세 (네이버 실시간 시세 API) ----------
// 예전엔 finance.naver.com 페이지를 jina로 렌더링해 텍스트로 받은 뒤 정규식으로 긁었다(요청당
// 4~5초, 게다가 네이버가 렌더링 형식을 두 가지로 들쭉날쭉 내보내 파싱도 불안정했음). 네이버 앱/
// 모바일이 실제로 쓰는 이 실시간 API는 종목코드 하나로 이름·현재가·등락·ISIN까지 깨끗한 JSON으로
// 바로 주고, 응답도 0.1~0.2초대라 훨씬 빠르고 안정적이다.
async function fetchQuote(code) {
  const text = await fetchText(`https://polling.finance.naver.com/api/realtime/domestic/stock/${code}`);
  const json = JSON.parse(text.slice(text.indexOf('{'))); // 브라우저 미리보기(jina 경유)에서는 앞에 텍스트가 붙어 올 수 있음
  const d = json.datas && json.datas[0];
  if (!d) throw new Error('종목을 찾을 수 없습니다. 종목코드를 확인해주세요.');
  return {
    name: d.stockName,
    price: Number(d.closePriceRaw),
    diff: Number(d.compareToPreviousClosePriceRaw),
    pct: Number(d.fluctuationsRatioRaw),
    isinCode: d.isinCode, // funetf의 itemId와 동일한 형식(KR7######00#) — 분배금 교차조회에 재사용
  };
}

// ---------- 국내종목 일별 시세 (분배 기준일의 주가를 보여주기 위함) ----------
// 네이버 siseJson API는 종목코드+기간을 넣으면 그 기간의 일별 OHLCV를 오래된 순으로 준다.
// 응답이 완전한 JSON이 아니라(헤더행이 단일따옴표) 파싱 대신 데이터행만 정규식으로 뽑는다.
let histPriceCache = {}; // code -> [{date:'YYYY-MM-DD', close}] (오래된순, 연초~오늘)
async function fetchHistoricalCloses(code) {
  if (histPriceCache[code]) return histPriceCache[code];
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const start = `${now.getFullYear()}0101`;
  const end = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const text = await fetchText(
    `https://api.finance.naver.com/siseJson.naver?symbol=${code}&requestType=1&startTime=${start}&endTime=${end}&timeframe=day`
  );
  const rows = [];
  const re = /\["(\d{8})",\s*[\d.]+,\s*[\d.]+,\s*[\d.]+,\s*([\d.]+),/g;
  let m;
  while ((m = re.exec(text))) rows.push({ date: ymd(m[1]), close: Number(m[2]) });
  histPriceCache[code] = rows;
  return rows;
}

// 분배 기준일은 휴장일(주말 등)일 수 있어, 그 날 이하로 가장 가까운 거래일의 종가를 쓴다.
function closeOnOrBefore(rows, dateStr) {
  let found = null;
  for (const r of rows) {
    if (r.date > dateStr) break;
    found = r;
  }
  return found ? found.close : null;
}

// ---------- 분배금 재원 분리 (옵션프리미엄=비과세 / 배당수익=과세) ----------
// 5개 운용사(삼성/미래에셋/신한/한국투자신탁/KB) 모두 "지급기준일 · 실지급일 · 분배금액(원) ·
// 주당과세표준액(원)" 4개 값을 공식 사이트에서 공시한다 — 형식(JSON API vs 서버렌더 표)과
// 필드명만 제각각이라, 여기서 종목마다 다르게 가져온 뒤 공통 형태로 정규화한다:
//   { basicDate, payDate, amount(분배금액/주), taxAmount(과세=배당 부분) } — 최신순 배열.
// 비과세(옵션프리미엄) 부분은 항상 amount - taxAmount.
function ymd(s) {
  if (!s) return '';
  if (s.includes('-')) return s;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

// 이제 5개 브랜드(TIGER/KODEX/SOL/ACE/RISE) 전부 addStockByCode()의 deriveKnownDist()가
// 실시간 검색으로 dist를 찾아 커스텀 종목 저장 시점에 직접 저장하므로, 이 목록은 더 이상
// 새 종목을 등록해둘 필요가 없다 — 그 라이브 조회 자체가 실패할 때(네트워크 문제 등)만 쓰이는
// 정적 백업용으로 남겨둔다.
const KNOWN_CUSTOM_DIST = {
  '0105E0': { type: 'sol', fundCd: '211097' }, // SOL 코리아고배당
};

// ---------- 분배금 교차검증 (funetf.co.kr 통합 데이터 + 운용사 공식 API) ----------
// funetf.co.kr은 5개 운용사 분배금을 한 API로 통합 제공하는 무료 ETF 정보 포털이다(로그인/프록시
// 불필요, 응답 0.1~0.2초). 종목코드(6자리)는 국내 상장 ISIN의 가운데 6자리와 항상 일치하므로
// (KR7 + 종목코드 + 확인자리, 실측으로 7종목 모두 확인), quickSearch로 이름 검색한 결과에서
// itemId의 4~9번째 글자가 종목코드와 일치하는 항목을 고르면 별도 매핑 없이 어떤 종목이든 itemId를
// 구할 수 있다. 이 itemId로 운용사 공식 API와 별개로 분배금을 조회해, 두 소스가 같은 금액을
// 말하는지 교차검증한다(운용사 공식 소스가 없는 커스텀 종목은 이 데이터만으로 자동조회가 된다).
const funetfItemIdCache = {};
async function resolveFunetfItemId(code) {
  if (funetfItemIdCache[code]) return funetfItemIdCache[code];
  const text = await fetchText(`https://www.funetf.co.kr/api/public/quickSearch/etf?keyword=${encodeURIComponent(code)}`);
  const arr = JSON.parse(text.slice(text.indexOf('[')));
  const hit = (arr || []).find((x) => x.itemId && x.itemId.slice(3, 9) === code.toUpperCase());
  if (!hit) throw new Error('funetf 매칭 실패');
  funetfItemIdCache[code] = hit.itemId;
  return hit.itemId;
}

async function fetchDistFunetf(code) {
  const itemId = await resolveFunetfItemId(code);
  const text = await fetchText(`https://www.funetf.co.kr/api/public/product/view/divBasic?itemId=${itemId}`);
  const json = JSON.parse(text.slice(text.indexOf('{')));
  const list = json.list || [];
  // funetf는 taxDivAmt(과세대상 배당분)를 상품에 따라 비워두는 경우가 있다(실측 확인) — 이 값이
  // 없으면 옵션/배당 분리 없이 "전액 과세"로 보수적으로 처리해 세후 금액이 NaN이 되는 대신
  // 실제보다 낮게(안전한 방향으로) 계산되게 한다. 운용사 공식 데이터가 있으면 그쪽 값이 우선
  // 쓰이므로(fetchDistribution 참고) 이 보수적 추정은 공식 소스가 없는 종목에서만 실제로 쓰인다.
  return list.map((d) => ({
    basicDate: ymd(d.divDt), payDate: ymd(d.payDt), amount: d.divAmt,
    taxAmount: d.taxDivAmt != null ? d.taxDivAmt : d.divAmt,
  }));
}

async function fetchOfficialDistribution(d) {
  if (d.type === 'samsung') return fetchDistSamsung(d.id);
  if (d.type === 'mirae') return fetchDistMirae(d.ksdFund, d.jongCode);
  if (d.type === 'sol') return fetchDistSol(d.fundCd);
  if (d.type === 'ace') return fetchDistAce(d.fundCode);
  if (d.type === 'rise') return fetchDistRise(d.slug);
  throw new Error('지원하지 않는 데이터 소스');
}

// 운용사 공식 API와 funetf 통합 데이터를 동시에 조회해 교차검증한다. 최신 분배금이 서로 같으면
// 'matched', 다르면 'mismatch'(그래도 운용사 공식값을 우선 사용), 한쪽만 성공하면 그 소스만 쓴다.
// 결과 배열에 verification/crossCheckAmount를 얹어 반환하므로, 기존에 배열만 소비하던 코드
// (loadDistribution/renderResult 등)는 그대로 동작한다.
async function fetchDistribution(stock) {
  const officialSpec = stock.dist || KNOWN_CUSTOM_DIST[stock.code];
  const [officialResult, funetfResult] = await Promise.allSettled([
    officialSpec ? fetchOfficialDistribution(officialSpec) : Promise.reject(new Error('공식 소스 없음')),
    fetchDistFunetf(stock.code),
  ]);
  const official = officialResult.status === 'fulfilled' && officialResult.value.length ? officialResult.value : null;
  const funetf = funetfResult.status === 'fulfilled' && funetfResult.value.length ? funetfResult.value : null;

  if (!official && !funetf) throw new Error('분배 재원 자동조회 실패');

  let list;
  if (official && funetf) {
    list = official;
    list.verification = official[0].amount === funetf[0].amount ? 'matched' : 'mismatch';
    list.crossCheckAmount = funetf[0].amount;
  } else if (official) {
    list = official;
    list.verification = 'official-only';
  } else {
    list = funetf;
    list.verification = 'funetf-only';
  }
  return list;
}

// 삼성자산운용(KODEX) 공식 API — 로그인/프록시 없이 직접 노출된 상품 JSON.
async function fetchDistSamsung(id) {
  const text = await fetchText(`https://www.samsungfund.com/api/v1/kodex/product/${id}.do`);
  const json = JSON.parse(text.slice(text.indexOf('{')));
  const list = json.info && json.info.divideList ? json.info.divideList : [];
  return list.map((d) => ({
    basicDate: ymd(d.BASIC_D), payDate: ymd(d.PAY_D), amount: d.DIVID_A, taxAmount: d.TAX_DIVID_A,
  }));
}

// 미래에셋자산운용(TIGER) 공식 AJAX — CORS가 전체 공개(*)라 프록시 없이 직접 fetch 가능.
async function fetchDistMirae(ksdFund, jongCode) {
  const url = `https://investments.miraeasset.com/tigeretf/ko/product/search/detail/refDivAjax.ajax?ksdFund=${ksdFund}&jongCode=${jongCode}&pageIndex=1&firstIndex=0&listCnt=200`;
  const text = await fetchText(url, 'direct');
  const rows = [];
  const re = /<td>\s*(\d{4}-\d{2}-\d{2})\s*<\/td>\s*<td>\s*(\d{4}-\d{2}-\d{2})\s*<\/td>\s*<td>\s*([\d,]+)\s*<\/td>\s*<td>\s*([\d,]+)\s*<\/td>/g;
  let m;
  while ((m = re.exec(text))) {
    rows.push({ basicDate: m[1], payDate: m[2], amount: Number(m[3].replace(/,/g, '')), taxAmount: Number(m[4].replace(/,/g, '')) });
  }
  return rows;
}

// 신한자산운용(SOL) 공식 API.
async function fetchDistSol(fundCd) {
  const text = await fetchText(`https://www.soletf.com/api/etf/pds/dividend/${fundCd}`);
  const json = JSON.parse(text.slice(text.indexOf('{')));
  const list = json.items || [];
  return list.map((d) => ({
    basicDate: ymd(d.WORK_DT), payDate: ymd(d.DIVIDEND_DT), amount: d.DIVIDEND_PRI, taxAmount: d.WEEK_PRI,
  }));
}

// 한국투자신탁운용(ACE) 공식 API.
async function fetchDistAce(fundCode) {
  const text = await fetchText(`https://papi.aceetf.co.kr/api/funds/${fundCode}/dividend?page=1`);
  const json = JSON.parse(text.slice(text.indexOf('{')));
  const list = json.dividendList || [];
  return list.map((d) => ({
    basicDate: ymd(d.std_DT), payDate: ymd(d.dividend_DT), amount: d.dividend_PRI, taxAmount: d.tax_PRI,
  }));
}

// KB자산운용(RISE) — 별도 API 없이 상품 상세 페이지에 표가 서버에서 이미 렌더링되어 있다. 페이지가
// 무겁고(공식 사이트 자체가 커버드콜 상품 전체 비교표를 같이 내려줌) jina 렌더링 형식에 파싱이
// 맞춰져 있어, 네이티브 앱에서도 이것만은 계속 jina를 거친다(교차검증용 보조 소스라 지연돼도
// 화면엔 funetf 값이 먼저 뜬 뒤라 체감 지연이 없다).
// 과세표준액이 0원인 달은 "-"로 표시되어 있어 0으로 취급한다.
// jina 프록시가 이 표를 내보내는 형식이 세션마다 왔다갔다한다는 걸 실측으로 확인함 — 2026-08-09에는
// 탭 구분 대신 마크다운 표(`| ... | ... |`)로 바뀐 걸 보고 정규식을 그쪽으로 고쳤는데, 이번
// 세션(2026-08-16)에 다시 순수 탭 구분(`날짜\t날짜\t금액\t금액`)으로 돌아온 걸 확인함 — 사이트
// 쪽이 아니라 jina 렌더링 자체가 들쭉날쭉한 것으로 보여서, 둘 다 시도하는 방식으로 고쳤다
// (마크다운 표 우선 시도 → 매치 없으면 탭 구분으로 재시도).
async function fetchDistRise(slug) {
  const text = await fetchText(`https://www.riseetf.co.kr/prod/finderDetail/${slug}`, 'jina');
  const rows = [];
  const reMarkdown = /\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*([\d,]+)\s*\|\s*(-|[\d,]+)\s*\|/g;
  const reTab = /(\d{4}-\d{2}-\d{2})\t(\d{4}-\d{2}-\d{2})\t([\d,]+)\t(-|[\d,]+)/g;
  let m;
  while ((m = reMarkdown.exec(text))) {
    rows.push({
      basicDate: m[1],
      payDate: m[2],
      amount: Number(m[3].replace(/,/g, '')),
      taxAmount: m[4] === '-' ? 0 : Number(m[4].replace(/,/g, '')),
    });
  }
  if (rows.length === 0) {
    while ((m = reTab.exec(text))) {
      rows.push({
        basicDate: m[1],
        payDate: m[2],
        amount: Number(m[3].replace(/,/g, '')),
        taxAmount: m[4] === '-' ? 0 : Number(m[4].replace(/,/g, '')),
      });
    }
  }
  return rows;
}

// ---------- 화면 전환 ----------
function showScreen(n) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  document.getElementById('screen-' + n).classList.add('active');

  document.querySelectorAll('.dot').forEach((d) => {
    const idx = Number(d.dataset.dot);
    d.classList.toggle('active', idx === n);
    d.classList.toggle('done', idx < n);
  });

  // 화면1(종목 선택)은 종목 선택 즉시 화면2로 자동 이동하므로 다음/이전 버튼이 필요 없다.
  els.navButtons.style.display = n === 1 ? 'none' : 'flex';
  els.btnNext.textContent = n === TOTAL_SCREENS ? '처음으로' : '다음';

  currentScreen = n;
  updateNextEnabled();

  if (n === 2) {
    renderHoldingCard();
    loadDistribution();
  }
  if (n === 3) renderResult();
}

function updateNextEnabled() {
  let valid = true;
  if (currentScreen === 2) valid = Number(els.shares.value) > 0 && Number(els.divPerUnit.value) > 0;
  els.btnNext.disabled = !valid;
}

els.btnNext.addEventListener('click', () => {
  if (currentScreen < TOTAL_SCREENS) {
    showScreen(currentScreen + 1);
  } else {
    resetApp();
    showScreen(1);
  }
});
els.btnPrev.addEventListener('click', () => {
  if (currentScreen > 1) showScreen(currentScreen - 1);
});

function resetApp() {
  selectedStock = null;
  quote = null;
  distList = null;
  els.shares.value = '';
  els.divPerUnit.value = '';
  els.divPerUnit.readOnly = true;
  document.querySelectorAll('.stock-item').forEach((el) => el.classList.remove('selected'));
  els.quoteStatus.textContent = '';
}

// ---------- 화면 1: 종목 선택 ----------
function renderStockList() {
  els.stockList.innerHTML = '';
  const list = allStocks();
  list.forEach((stock) => {
    const item = document.createElement('div');
    item.className = 'stock-item';
    item.dataset.code = stock.code;
    item.setAttribute('role', 'button');
    item.setAttribute('tabindex', '0');
    item.innerHTML = `
      <span class="stock-info">
        <span class="stock-name">${stock.name}</span>
        <span class="stock-meta">${stock.code} · ${stock.issuer}</span>
        <span class="stock-dist">${stock.market !== 'US' ? '분배 조회 중...' : (manualDist[stock.code] ? `월배당금(직접입력) ${formatKRW(manualDist[stock.code])}` : '')}</span>
      </span>
      <span class="stock-quote">
        <span class="stock-quote-price">-</span>
        <span class="stock-quote-diff"></span>
      </span>
      ${stock.custom ? '<button type="button" class="stock-delete-btn" title="목록에서 삭제">×</button>' : ''}
    `;
    item.addEventListener('click', () => selectStock(stock, item));
    if (stock.custom) {
      item.querySelector('.stock-delete-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        removeCustomStock(stock.code);
      });
    }
    els.stockList.appendChild(item);
  });
  // 리스트에 종목명 오른쪽으로 현재가/등락률/최근 분배금을 선택 없이 바로 보여준다 (선택 시
  // selectStock/loadDistribution이 이 캐시들을 재사용). 네이티브 앱은 더 이상 공용 jina 프록시를
  // 거치지 않고 각 공식 API에 직접 붙으므로(운용사별로 서버가 다름) 종목 수만큼 동시에 요청해도
  // 예전처럼 프록시 레이트리밋에 걸릴 일이 없다 — 시세/분배도 서로 기다리지 않고 병렬로 받는다.
  runWithConcurrency(list, (stock) => Promise.all([loadListQuote(stock), loadListDist(stock)]), 8);
}

// items를 최대 limit개씩 동시에 처리하는 간단한 동시성 제한 헬퍼.
async function runWithConcurrency(items, worker, limit) {
  let idx = 0;
  async function next() {
    while (idx < items.length) {
      const i = idx++;
      await worker(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
}

async function loadListQuote(stock) {
  const row = els.stockList.querySelector(`.stock-item[data-code="${stock.code}"]`);
  try {
    const q = await fetchQuoteForStock(stock);
    quoteCache[stock.code] = q;
    if (!row) return;
    renderRowQuote(row, q);
  } catch (err) {
    if (row) row.querySelector('.stock-quote-price').textContent = '조회 실패';
  }
}

function renderRowQuote(row, q) {
  const sign = q.diff > 0 ? '+' : '';
  const cls = q.diff > 0 ? 'diff-up' : q.diff < 0 ? 'diff-down' : '';
  row.querySelector('.stock-quote-price').textContent = formatQuotePrice(q);
  const diffEl = row.querySelector('.stock-quote-diff');
  diffEl.textContent = `${sign}${q.pct}%`;
  diffEl.className = 'stock-quote-diff ' + cls;
}

// 지급일(payDate, 없으면 기준일 basicDate)의 '일'을 보고 월초(1~10일)/월중(11~20일)/
// 월말(21일~)로 분류 — 위클리 상품도 최근 1회분 기준으로 대략적인 시기만 보여준다.
function payTimingLabel(d) {
  const dateStr = d.payDate || d.basicDate;
  if (!dateStr) return '';
  const day = Number(dateStr.slice(8, 10));
  if (!day) return '';
  if (day <= 10) return '·월초';
  if (day <= 20) return '·월중';
  return '·월말';
}

// fetchDistribution이 붙여준 verification 값을 화면 문구로 변환한다.
function distVerificationText(verification, crossCheckAmount) {
  if (verification === 'matched') return '✓ 운용사 공식 데이터 · funetf 통합 데이터 2곳 교차 확인됨';
  if (verification === 'mismatch') return `⚠ 소스 간 금액 차이 있음(교차확인 참고값 ${crossCheckAmount}원) — 운용사 공식 데이터 기준으로 표시`;
  if (verification === 'funetf-only') return '(운용사 공식 교차확인 없음 · funetf 통합 데이터 기준)';
  return ''; // 'official-only' — 예전처럼 운용사 공식 데이터만 있고 교차확인은 없었던 경우, 문구 없이 조용히 표시
}

async function loadListDist(stock) {
  if (stock.market === 'US') return; // 미국주식은 옵션/배당 재원분리 세금모델 대상이 아니라 자동조회 대상에서 제외(수동입력 폴백)
  const row = els.stockList.querySelector(`.stock-item[data-code="${stock.code}"]`);
  const distEl = row && row.querySelector('.stock-dist');
  try {
    const list = await fetchDistribution(stock);
    distCache[stock.code] = list;
    if (!distEl) return;
    if (!list || list.length === 0) {
      distEl.textContent = '분배 내역 없음';
      return;
    }
    const latest = list[0];
    const month = Number(latest.basicDate.slice(5, 7));
    const price = quoteCache[stock.code] && quoteCache[stock.code].price;
    const rateText = price ? ` (${(latest.amount / price * 100).toFixed(2)}%)` : '';
    const timing = payTimingLabel(latest);
    const check = list.verification === 'matched' ? '✓ ' : '';
    distEl.textContent = `${check}최근 분배(${month}월${timing}) ${latest.amount}원${rateText}`;
  } catch (err) {
    if (distEl) distEl.textContent = '분배 조회 실패';
  }
}

// ---------- 종목 직접 추가 (코드 또는 이름) ----------
els.btnShowAddStock.addEventListener('click', () => {
  const showing = els.stockAddForm.style.display !== 'none';
  els.stockAddForm.style.display = showing ? 'none' : 'flex';
  els.addStockStatus.textContent = '';
  els.stockSearchResults.style.display = 'none';
  els.stockSearchResults.innerHTML = '';
  if (!showing) els.customCodeInput.focus();
});

// 종목코드(6자리 영문+숫자)면 바로 코드로 추가, 아니면 이름 검색으로 처리한다.
els.btnConfirmAddStock.addEventListener('click', async () => {
  const input = els.customCodeInput.value.trim();
  if (!input) return;
  els.stockSearchResults.style.display = 'none';
  els.stockSearchResults.innerHTML = '';

  if (/^[0-9A-Za-z]{6}$/.test(input)) {
    await addStockByCode(input.toUpperCase());
    return;
  }

  els.btnConfirmAddStock.disabled = true;
  els.addStockStatus.textContent = '종목명 검색 중...';
  try {
    const matches = await searchAllStocks(input);
    if (matches.length === 0) {
      els.addStockStatus.textContent = '❌ 일치하는 종목을 찾을 수 없습니다.';
    } else if (matches.length === 1) {
      await addStockByCode(matches[0].code, matches[0].market);
    } else {
      els.addStockStatus.textContent = `${matches.length}개 종목이 검색되었습니다. 아래에서 선택하세요.`;
      renderSearchResults(matches);
    }
  } catch (err) {
    els.addStockStatus.textContent = '❌ 종목명 검색에 실패했습니다.';
  } finally {
    els.btnConfirmAddStock.disabled = false;
  }
});

function renderSearchResults(matches) {
  els.stockSearchResults.innerHTML = matches.map((m) => `
    <button type="button" class="stock-search-item" data-code="${m.code}" data-market="${m.market || 'KR'}">
      <span class="stock-search-name">${m.name}${m.market === 'US' ? ' · 미국' : ''}</span>
      <span class="stock-search-code">${m.code}</span>
    </button>
  `).join('');
  els.stockSearchResults.style.display = 'flex';
  els.stockSearchResults.querySelectorAll('.stock-search-item').forEach((btn) => {
    btn.addEventListener('click', () => addStockByCode(btn.dataset.code, btn.dataset.market));
  });
}

async function addStockByCode(code, market) {
  if (allStocks().some((s) => s.code === code)) {
    els.addStockStatus.textContent = '이미 목록에 있는 종목입니다.';
    return;
  }
  els.btnConfirmAddStock.disabled = true;
  els.addStockStatus.textContent = '종목 확인 중...';
  try {
    let name, q, dist = null, issuer;
    if (market === 'US') {
      q = await fetchUsQuote(code);
      name = q.name;
      issuer = '미국주식';
    } else {
      q = await fetchQuote(code);
      name = q.name;
      els.addStockStatus.textContent = '분배 소스 확인 중...';
      dist = await deriveKnownDist(code, name);
      issuer = dist ? ISSUER_LABELS[dist.type] : '직접 추가(통합데이터)';
    }
    customStocks.push({ code, name, issuer, custom: true, dist, market: market === 'US' ? 'US' : undefined });
    saveCustomStocks(customStocks);
    quoteCache[code] = q;
    els.customCodeInput.value = '';
    els.stockSearchResults.style.display = 'none';
    els.stockSearchResults.innerHTML = '';
    els.addStockStatus.textContent = `✅ "${name}" 추가되었습니다.`;
    els.stockAddForm.style.display = 'none';
    renderStockList();
  } catch (err) {
    els.addStockStatus.textContent = '❌ ' + err.message;
  } finally {
    els.btnConfirmAddStock.disabled = false;
  }
}

function removeCustomStock(code) {
  customStocks = customStocks.filter((s) => s.code !== code);
  saveCustomStocks(customStocks);
  if (selectedStock && selectedStock.code === code) {
    resetApp();
    showScreen(1);
  }
  renderStockList();
}

// 종목을 탭하면 시세를 확보하는 즉시 화면2(보유수량)로 바로 넘어간다 — 별도 '다음' 버튼 없음.
// 목록 로드 시 이미 quoteCache에 시세가 채워져 있는 경우가 대부분이라 보통 지연 없이 바로 넘어간다.
async function selectStock(stock, itemEl) {
  selectedStock = stock;
  distList = distCache[stock.code] || null;
  document.querySelectorAll('.stock-item').forEach((el) => el.classList.remove('selected'));
  itemEl.classList.add('selected');

  quote = null;
  els.quoteStatus.textContent = '';

  const cached = quoteCache[stock.code];
  if (cached) {
    quote = cached;
    showScreen(2);
    return;
  }

  els.quoteStatus.textContent = '시세 조회 중...';
  try {
    const q = await fetchQuoteForStock(stock);
    quoteCache[stock.code] = q;
    if (selectedStock !== stock) return; // 그 사이 다른 종목을 선택함
    quote = q;
    els.quoteStatus.textContent = '';
    showScreen(2);
  } catch (err) {
    if (selectedStock !== stock) return;
    els.quoteStatus.textContent = '시세 조회 실패 — 잠시 후 다시 시도해주세요.';
  }
}

// ---------- 화면 2: 보유수량 ----------
function renderHoldingCard() {
  els.sharesTitle.textContent = `${selectedStock.name} 보유 수량`;
  els.sharesSub.textContent = '보유하고 계신 주수를 입력하세요';
  updateHoldingValue();
}

function updateHoldingValue() {
  const shares = Number(els.shares.value);
  const valid = shares > 0 && quote;
  els.holdingCard.style.display = valid ? 'block' : 'none';
  els.totalValue.textContent = valid ? formatHoldingValue(shares, quote) : '-';
}
els.shares.addEventListener('input', () => {
  updateHoldingValue();
  updateNextEnabled();
});

// ---------- 화면 2 (분배금 부분): 분배금 확인 ----------
async function loadDistribution() {
  els.splitCard.style.display = 'none';
  els.manualDivBlock.style.display = 'none';
  els.divPerUnit.readOnly = true;
  els.divPerUnit.value = '';
  els.divTitle.textContent = '분배금 확인 중';
  els.divStatus.textContent = '공식 데이터 조회 중...';
  els.payDateStatus.textContent = '';
  const stock = selectedStock;

  try {
    if (!distList) distList = await fetchDistribution(stock);
    if (selectedStock !== stock) return; // 그 사이 다른 종목을 선택함
    if (!distList || distList.length === 0) throw new Error('분배 내역 없음');
    const latest = distList[0];
    els.divPerUnit.value = latest.amount;
    const optionAmt = latest.amount - latest.taxAmount;
    els.divTitle.textContent = `${latest.basicDate} 분배금`;
    els.divStatus.textContent = distVerificationText(distList.verification, distList.crossCheckAmount);
    els.splitOption.textContent = `옵션 ${formatKRW(optionAmt)}`;
    els.splitDividend.textContent = `배당 ${formatKRW(latest.taxAmount)}`;
    els.splitCard.style.display = 'block';
    els.payDateStatus.textContent = `실지급일 ${latest.payDate}`;
  } catch (err) {
    if (selectedStock !== stock) return;
    // 자동 조회가 실패한 경우에만 수동 입력으로 대체 (7종목 모두 공식 소스가 있지만, 네트워크
    // 문제 등으로 실패할 수 있음 — 이 경우 사용자가 공시를 참고해 직접 입력할 수 있게 한다).
    els.divTitle.textContent = '분배금 입력';
    els.divPerUnit.readOnly = false;
    els.divPerUnit.placeholder = '예: 200';
    if (manualDist[stock.code]) els.divPerUnit.value = manualDist[stock.code];
    els.divStatus.textContent = '자동 조회 실패 — 공시를 참고해 직접 입력해주세요.';
    els.manualDivBlock.style.display = 'block';
    els.payDateStatus.textContent = '';
  } finally {
    if (selectedStock === stock) updateNextEnabled();
  }
}
els.divPerUnit.addEventListener('input', () => {
  updateNextEnabled();
  if (!els.divPerUnit.readOnly && selectedStock) {
    const v = Number(els.divPerUnit.value);
    if (v > 0) saveManualDistValue(selectedStock.code, v);
  }
});

// ---------- 화면 4: 결과 ----------
function renderResult() {
  const shares = Number(els.shares.value) || 0;
  const divPerUnit = Number(els.divPerUnit.value) || 0;
  const preTax = shares * divPerUnit;

  els.metaShares.textContent = `${shares.toLocaleString('ko-KR')}주 보유`;
  els.metaTotalValue.textContent = quote ? formatHoldingValue(shares, quote) : '-';
  els.preTaxKrw.textContent = formatKRW(preTax);

  els.resultTitle.textContent = `${selectedStock.name} 분배금 결과`;

  if (distList && distList.length) {
    const latest = distList[0];
    // 공식 분배율(기준가 대비) 대신, 이슈어마다 제공 여부가 달라 항상 구할 수 있는
    // "이번 분배금 / 현재가"로 근사한 분배율을 부제목에 표시한다.
    const month = Number(latest.basicDate.slice(5, 7));
    const rate = quote ? ((latest.amount / quote.price) * 100).toFixed(2) : null;
    els.resultSubtitle.textContent = rate
      ? `(${month}월 ${rate}% 분배, 분배금 ${formatKRW(latest.amount)})`
      : '';
    const optionPerUnit = latest.amount - latest.taxAmount;
    const dividendPerUnit = latest.taxAmount;
    const optionTotal = shares * optionPerUnit;
    const dividendTotal = shares * dividendPerUnit;
    const tax = dividendTotal * TAX_RATE;
    const postTax = preTax - tax;

    els.splitRow.style.display = '';
    els.taxRow.style.display = '';
    els.splitDetail.textContent = `옵션 ${formatKRW(optionTotal)} · 배당 ${formatKRW(dividendTotal)}`;
    els.splitDetailPerShare.textContent = `주당 옵션 ${optionPerUnit}원 · 배당 ${dividendPerUnit}원`;
    els.taxKrw.textContent = '-' + formatKRW(tax);
    els.postTaxLabel.textContent = '세후 실수령액';
    els.postTaxKrw.textContent = formatKRW(postTax);
    els.unsupportedNote.style.display = 'none';

    renderYearlyBreakdown(shares, distList);
  } else {
    els.resultSubtitle.textContent = '';
    els.splitRow.style.display = 'none';
    els.taxRow.style.display = 'none';
    els.postTaxLabel.textContent = '합계 (세전, 세후금액 미지원)';
    els.postTaxKrw.textContent = formatKRW(preTax);
    els.unsupportedNote.style.display = 'block';
    els.yearlyBlock.style.display = 'none';
  }
}

function renderYearlyBreakdown(shares, list) {
  els.yearlyBlock.style.display = 'block';

  const currentYear = String(new Date().getFullYear());
  els.yearlyTitle.textContent = `${currentYear}년 월별 분배금 내역 (세후)`;

  const rows = [];
  let sumPostTax = 0;
  let sumOption = 0;
  let sumDividend = 0;
  let sumPerShare = 0;
  // list는 최신순 -> 화면에는 오래된 순으로 보여준다. 올해 기록만 보여준다.
  const chron = list.filter((d) => d.basicDate.startsWith(currentYear)).reverse();
  chron.forEach((d) => {
    const optionAmt = shares * (d.amount - d.taxAmount);
    const dividendAmt = shares * d.taxAmount;
    const tax = dividendAmt * TAX_RATE;
    const postTax = shares * d.amount - tax;
    sumPostTax += postTax;
    sumOption += optionAmt;
    sumDividend += dividendAmt;
    sumPerShare += d.amount;
    rows.push(`
      <div class="yearly-row">
        <div class="yearly-row-top">
          <span class="yearly-month">${d.basicDate.slice(5)}</span>
          <span class="yearly-per-share">${d.amount}원(옵션${d.amount - d.taxAmount}·배당${d.taxAmount})</span>
          <span class="yearly-amount">${formatKRW(postTax)}</span>
        </div>
        <div class="yearly-row-sub" data-price-date="${d.basicDate}">기준일 주가 조회 중…</div>
      </div>
    `);
  });

  if (chron.length === 0) {
    els.yearlyList.innerHTML = '<p class="yearly-empty">데이터 없음</p>';
    els.yearlySummary.innerHTML = '';
    return;
  }

  els.yearlyList.innerHTML = rows.join('');
  if (selectedStock && selectedStock.market !== 'US') {
    loadHistoricalPrices(selectedStock, chron.map((d) => d.basicDate));
  } else {
    els.yearlyList.querySelectorAll('.yearly-row-sub').forEach((el) => { el.style.display = 'none'; });
  }

  const avgPostTax = sumPostTax / chron.length;
  const avgPerShare = sumPerShare / chron.length;
  els.yearlySummary.innerHTML = `
    <div class="yearly-summary-row">
      <div class="yearly-summary-row-top">
        <span class="yearly-summary-label">${currentYear}년 합계 (${chron.length}회, 세후)</span>
        <span class="value-krw">${formatKRW(sumPostTax)}</span>
      </div>
      <div class="yearly-summary-sub-line">(옵션 ${formatKRW(sumOption)} · 배당 ${formatKRW(sumDividend)} · 주당 총 ${sumPerShare}원)</div>
    </div>
    <div class="yearly-summary-row">
      <div class="yearly-summary-row-top">
        <span class="yearly-summary-label">${currentYear}년 회당 평균 (세후)</span>
        <span class="value-krw">${formatKRW(avgPostTax)}</span>
      </div>
      <div class="yearly-summary-sub-line">(주당 평균 ${avgPerShare.toFixed(1)}원)</div>
    </div>
  `;
}

// 기준일 주가는 시세 API 별도 호출이 필요해 위 렌더링과 분리했다 — 실패해도 나머지 결과 화면은
// 정상 표시돼야 하므로 실패 시 조용히 숨긴다. 조회 중 다른 종목으로 넘어가면 결과를 버린다.
async function loadHistoricalPrices(stock, dates) {
  try {
    const rows = await fetchHistoricalCloses(stock.code);
    if (selectedStock !== stock) return;
    dates.forEach((dateStr) => {
      const el = els.yearlyList.querySelector(`.yearly-row-sub[data-price-date="${dateStr}"]`);
      if (!el) return;
      const price = closeOnOrBefore(rows, dateStr);
      if (price == null) {
        el.style.display = 'none';
      } else {
        el.textContent = `기준일(${dateStr.slice(5)}) 주가 ${formatKRW(price)}`;
      }
    });
  } catch (e) {
    if (selectedStock !== stock) return;
    els.yearlyList.querySelectorAll('.yearly-row-sub').forEach((el) => { el.style.display = 'none'; });
  }
}

renderStockList();
showScreen(1);

// ---------- 화면 1 pull-to-refresh: "분배 내역 없음"/"분배 조회 실패" 종목만 재조회 ----------
// 무료 jina 프록시가 가끔 일시적으로 실패하는 걸 확인했는데(withRetry로 이미 어느 정도 대응하지만
// 완전히 막지는 못함), 전체 새로고침(페이지 리로드) 없이 실패한 종목만 다시 불러올 수 있게 한다.
const PTR_THRESHOLD = 70;
let ptrStartY = null;
let ptrDy = 0;
let ptrPulling = false;
let ptrRefreshing = false;

function ptrAtTop() {
  const el = document.scrollingElement || document.documentElement;
  return el.scrollTop <= 0;
}

document.addEventListener('touchstart', (e) => {
  if (currentScreen !== 1 || ptrRefreshing) return;
  if (!ptrAtTop()) return;
  ptrStartY = e.touches[0].clientY;
  ptrPulling = false;
  ptrDy = 0;
}, { passive: true });

document.addEventListener('touchmove', (e) => {
  if (currentScreen !== 1 || ptrRefreshing || ptrStartY == null) return;
  if (!ptrAtTop()) { ptrStartY = null; ptrPulling = false; return; }
  const dy = e.touches[0].clientY - ptrStartY;
  if (dy <= 10) return;
  ptrPulling = true;
  ptrDy = dy;
  els.ptrIndicator.style.display = 'block';
  els.ptrIndicator.textContent = dy > PTR_THRESHOLD ? '↑ 놓으면 새로고침' : '↓ 당겨서 새로고침';
}, { passive: true });

document.addEventListener('touchend', () => {
  if (currentScreen === 1 && ptrPulling && ptrDy > PTR_THRESHOLD) {
    refreshFailedDistributions();
  } else if (els.ptrIndicator) {
    els.ptrIndicator.style.display = 'none';
  }
  ptrStartY = null;
  ptrPulling = false;
  ptrDy = 0;
});

async function refreshFailedDistributions() {
  ptrRefreshing = true;
  els.ptrIndicator.style.display = 'block';
  const targets = [];
  els.stockList.querySelectorAll('.stock-item').forEach((row) => {
    const distEl = row.querySelector('.stock-dist');
    if (!distEl) return;
    const text = distEl.textContent;
    if (text === '분배 내역 없음' || text === '분배 조회 실패') {
      const stock = allStocks().find((s) => s.code === row.dataset.code);
      if (stock) {
        targets.push(stock);
        distEl.textContent = '분배 조회 중...';
      }
    }
  });

  if (targets.length === 0) {
    els.ptrIndicator.textContent = '새로고침할 항목이 없습니다';
  } else {
    els.ptrIndicator.textContent = `${targets.length}개 종목 새로고침 중...`;
    await runWithConcurrency(targets, (stock) => loadListDist(stock), 3);
    els.ptrIndicator.textContent = '완료';
  }
  setTimeout(() => {
    els.ptrIndicator.style.display = 'none';
    ptrRefreshing = false;
  }, 800);
}

// ---------- 실패한 시세/분배금 자동 재시도 ----------
// 사용자 요청: "조회 실패 뜨는 종목은 될 때까지 계속 시도해달라, 실패한 종목만" — 위의
// pull-to-refresh는 사용자가 직접 당겨야 하므로, 그와 별개로 백그라운드에서 일정 간격마다
// 스스로 확인해서 그 시점에 "조회 실패" 상태인 종목만 골라 재시도한다. 이미 성공한 종목은
// 이 루프가 절대 다시 요청하지 않는다(리스트 렌더 시 이미 채워진 값을 건드리지 않음).
const AUTO_RETRY_INTERVAL_MS = 10000;
let autoRetryRunning = false;

async function autoRetryFailedItems() {
  if (autoRetryRunning) return; // 이전 재시도가 아직 진행 중이면 이번 틱은 건너뜀(중복 요청 방지)
  const quoteTargets = [];
  const distTargets = [];
  els.stockList.querySelectorAll('.stock-item').forEach((row) => {
    const stock = allStocks().find((s) => s.code === row.dataset.code);
    if (!stock) return;
    const priceEl = row.querySelector('.stock-quote-price');
    if (priceEl && priceEl.textContent === '조회 실패') quoteTargets.push(stock);
    const distEl = row.querySelector('.stock-dist');
    if (distEl && (distEl.textContent === '분배 내역 없음' || distEl.textContent === '분배 조회 실패')) {
      distTargets.push(stock);
    }
  });
  if (quoteTargets.length === 0 && distTargets.length === 0) return;

  autoRetryRunning = true;
  try {
    if (quoteTargets.length) await runWithConcurrency(quoteTargets, (s) => loadListQuote(s), 3);
    if (distTargets.length) await runWithConcurrency(distTargets, (s) => loadListDist(s), 3);
  } finally {
    autoRetryRunning = false;
  }
}

setInterval(autoRetryFailedItems, AUTO_RETRY_INTERVAL_MS);

// ---------- 안드로이드 하드웨어 뒤로가기: 앱 종료 대신 이전 화면으로 이동 ----------
// capacitor.js가 로드된 네이티브 APK 안에서만 window.Capacitor가 존재 — 웹(GitHub Pages)에서는
// 조용히 아무 일도 하지 않는다.
if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
  window.Capacitor.Plugins.App.addListener('backButton', () => {
    if (currentScreen > 1) {
      showScreen(currentScreen - 1);
    } else {
      window.Capacitor.Plugins.App.exitApp();
    }
  });
}
