const TAX_RATE = 0.154; // 배당소득세(14%) + 지방소득세(1.4%)
const TOTAL_SCREENS = 3; // 1: 종목선택, 2: 보유수량+분배금 확인(통합), 3: 결과
const JINA_PROXY = 'https://r.jina.ai/';

let currentScreen = 1;
let selectedStock = null;
let quote = null; // { price, diff, pct, date }
let distList = null; // 선택된 종목의 월별 분배 내역 (최신순), fetchDistribution()의 정규화된 결과
const quoteCache = {}; // code -> { price, diff, pct } (종목 리스트에서 미리 조회해둔 값, 선택 시 재사용)
const distCache = {}; // code -> 분배 내역 배열 (종목 리스트에서 미리 조회해둔 값, 선택 시 재사용)

// ---------- 업데이트 확인 ----------
// 사이드로드 앱은 스스로를 조용히 덮어쓸 수 없으므로(설치는 항상 사용자 확인 필요),
// 새 버전이 있으면 외부 브라우저로 APK 다운로드 URL을 열어 다운로드->설치를 대신 시작해준다.
const APP_VERSION_CODE = 5;
const APP_VERSION_NAME = "1.4";
const UPDATE_MANIFEST_URL = "https://green3077.github.io/kr-etf-calculator/version.json";
const IS_NATIVE_UPDATE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
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
  const text = await fetchProxiedText(`https://www.samsungfund.com/api/v1/kodex/product.do?srchTerm=w&srchVal=${code}&ordrColm=NAV&ordrSort=DESC&pageNo=1`);
  const json = JSON.parse(text.slice(text.indexOf('[')));
  const hit = json.find((it) => it.stkTicker === code);
  return hit ? { type: 'samsung', id: hit.fId } : null;
}

// 신한자산운용(SOL) 공식 검색 API — 종목코드로는 매치가 안 되고 이름(브랜드명 포함 전체)으로
// 검색해야 한다(실측 확인). ETF_CD6이 우리 종목코드와 일치하는 항목의 FUND_CD를 쓴다.
async function findSolDist(code, name) {
  const text = await fetchProxiedText(`https://www.soletf.com/api/etf/pds/search?keyword=${encodeURIComponent(name)}`);
  const json = JSON.parse(text.slice(text.indexOf('{')));
  const hit = (json.items || []).find((it) => it.ETF_CD6 === code);
  return hit ? { type: 'sol', fundCd: hit.FUND_CD } : null;
}

// 한국투자신탁운용(ACE) 전체 상품 목록 API — size를 총 상품수(현재 111개)보다 크게 주면
// 페이지네이션 없이 한 번에 다 온다. stockCd가 표준 ISIN이라 computeKrIsin(code)과 정확히
// 일치하는 항목을 찾는다.
async function findAceDist(code) {
  const text = await fetchProxiedText('https://papi.aceetf.co.kr/api/funds?size=300');
  const json = JSON.parse(text.slice(text.indexOf('{')));
  const isin = computeKrIsin(code);
  const hit = (json.data || []).find((it) => it.stockCd === isin);
  return hit ? { type: 'ace', fundCode: hit.fundCd } : null;
}

// KB자산운용(RISE) 실제 상품검색 AJAX(POST/GET 둘 다 됨) — searchText에 종목코드를 넣으면
// 상세페이지 링크(/prod/finderDetail/{slug})가 결과 HTML에 그 상품 하나만 남는다.
async function findRiseDist(code) {
  const text = await fetchProxiedText(`https://www.riseetf.co.kr/prod/finder/listJquery?searchText=${code}&page=1&searchOrder=&searchBoardType=&searchFieldType=`);
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
  const text = await fetchProxiedText('https://finance.naver.com/api/sise/etfItemList.nhn');
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

async function fetchProxiedText(url) {
  return withRetry(async () => {
    const res = await fetch(JINA_PROXY + url);
    if (!res.ok) throw new Error('조회 실패');
    return res.text();
  });
}

async function fetchDirectText(url) {
  return withRetry(async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error('조회 실패');
    return res.text();
  });
}

// ---------- 시세 (네이버 금융) ----------
// 네이버는 같은 종목이라도 요청할 때마다 두 형식 중 하나로 들쭉날쭉하게 시세를 렌더링한다
// (종목별로 고정된 게 아니라 매 요청마다 달라지는 걸 실제로 확인함):
//  A) 스크린리더용 평문 요약: "현재가 9,795 전일대비 하락 155 마이너스 1.56 퍼센트" — 항상 깨끗함.
//  B) 화면 표시용 언더스코어 블록. 숫자를 한 글자씩 공백으로 쪼개서 내보내는데, 그 앞에
//     "깨끗한 값"이 한 번 더 붙어 있을 때도("_18,895 1 8,8 9 5_") 없을 때도("_1 8,8 9 5_") 있다.
//     그래서 공백을 무조건 지우고 나서, 그 결과가 "같은 문자열이 정확히 두 번 반복"된 형태면
//     (=깨끗한 값+중복 케이스) 앞 절반만 취하고, 아니면(=중복만 있는 케이스) 그대로 쓴다.
function dedupeNaverHalf(stripped) {
  const half = stripped.length / 2;
  if (Number.isInteger(half) && half > 0 && stripped.slice(0, half) === stripped.slice(half)) {
    return stripped.slice(0, half);
  }
  return stripped;
}

// 종목명은 jina가 붙이는 "Title: {이름} - Npay 증권" 줄에서 뽑는다 — 두 형식 모두에서 공통으로
// 존재해서, 사용자가 직접 종목을 추가할 때 이름을 따로 입력받지 않고 자동으로 채우는 데 쓴다.
async function fetchNaverPage(code) {
  const text = await fetchProxiedText(`https://finance.naver.com/item/main.naver?code=${code}`);
  const titleMatch = text.match(/^Title:\s*(.+?)\s*-\s*Npay/m);
  const name = titleMatch ? titleMatch[1].trim() : null;

  let quote = null;
  const a = text.match(/현재가 ([\d,]+) 전일대비 (상승|하락|보합) ([\d,]+)(?: 마이너스)? ([\d.]+) 퍼센트/);
  if (a) {
    const price = parseFloat(a[1].replace(/,/g, ''));
    const dir = a[2];
    const diffAbs = parseFloat(a[3].replace(/,/g, ''));
    const diff = dir === '하락' ? -diffAbs : dir === '상승' ? diffAbs : 0;
    const pct = dir === '하락' ? -parseFloat(a[4]) : parseFloat(a[4]);
    quote = { price, diff, pct };
  } else {
    const b = text.match(/_([\d, ]+)_\s*\n\s*전일대비 _(상승|하락|보합) ([\d, ]+)_ ?l? ?_([+\-\d,. %]+)_/);
    if (b) {
      const price = parseFloat(dedupeNaverHalf(b[1].replace(/\s+/g, '')).replace(/,/g, ''));
      const dir = b[2];
      const diffAbs = parseFloat(dedupeNaverHalf(b[3].replace(/\s+/g, '')).replace(/,/g, ''));
      const diff = dir === '하락' ? -diffAbs : dir === '상승' ? diffAbs : 0;
      // 부호(+/-)는 공백으로 쪼개진 두 절반에 비대칭으로 붙어있어 dedupe 비교가 깨지므로
      // 미리 떼어내고, 대신 방향 단어(dir)로 부호를 다시 결정한다.
      const pctDigits = dedupeNaverHalf(b[4].replace(/[+\-%\s]/g, ''));
      const pctAbs = parseFloat(pctDigits);
      const pct = dir === '하락' ? -pctAbs : dir === '상승' ? pctAbs : 0;
      quote = { price, diff, pct };
    }
  }

  return { name, quote };
}

async function fetchQuote(code) {
  const { quote } = await fetchNaverPage(code);
  if (!quote) throw new Error('시세 파싱 실패');
  return quote;
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

async function fetchDistribution(stock) {
  const d = stock.dist || KNOWN_CUSTOM_DIST[stock.code];
  if (!d) throw new Error('분배 재원 자동조회 미지원 종목');
  if (d.type === 'samsung') return fetchDistSamsung(d.id);
  if (d.type === 'mirae') return fetchDistMirae(d.ksdFund, d.jongCode);
  if (d.type === 'sol') return fetchDistSol(d.fundCd);
  if (d.type === 'ace') return fetchDistAce(d.fundCode);
  if (d.type === 'rise') return fetchDistRise(d.slug);
  throw new Error('지원하지 않는 데이터 소스');
}

// 삼성자산운용(KODEX) 공식 API — 로그인/프록시 없이 직접 노출된 상품 JSON.
async function fetchDistSamsung(id) {
  const text = await fetchProxiedText(`https://www.samsungfund.com/api/v1/kodex/product/${id}.do`);
  const json = JSON.parse(text.slice(text.indexOf('{')));
  const list = json.info && json.info.divideList ? json.info.divideList : [];
  return list.map((d) => ({
    basicDate: ymd(d.BASIC_D), payDate: ymd(d.PAY_D), amount: d.DIVID_A, taxAmount: d.TAX_DIVID_A,
  }));
}

// 미래에셋자산운용(TIGER) 공식 AJAX — CORS가 전체 공개(*)라 프록시 없이 직접 fetch 가능.
async function fetchDistMirae(ksdFund, jongCode) {
  const url = `https://investments.miraeasset.com/tigeretf/ko/product/search/detail/refDivAjax.ajax?ksdFund=${ksdFund}&jongCode=${jongCode}&pageIndex=1&firstIndex=0&listCnt=200`;
  const text = await fetchDirectText(url);
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
  const text = await fetchProxiedText(`https://www.soletf.com/api/etf/pds/dividend/${fundCd}`);
  const json = JSON.parse(text.slice(text.indexOf('{')));
  const list = json.items || [];
  return list.map((d) => ({
    basicDate: ymd(d.WORK_DT), payDate: ymd(d.DIVIDEND_DT), amount: d.DIVIDEND_PRI, taxAmount: d.WEEK_PRI,
  }));
}

// 한국투자신탁운용(ACE) 공식 API.
async function fetchDistAce(fundCode) {
  const text = await fetchProxiedText(`https://papi.aceetf.co.kr/api/funds/${fundCode}/dividend?page=1`);
  const json = JSON.parse(text.slice(text.indexOf('{')));
  const list = json.dividendList || [];
  return list.map((d) => ({
    basicDate: ymd(d.std_DT), payDate: ymd(d.dividend_DT), amount: d.dividend_PRI, taxAmount: d.tax_PRI,
  }));
}

// KB자산운용(RISE) — 별도 API 없이 상품 상세 페이지에 표가 서버에서 이미 렌더링되어 있다.
// 과세표준액이 0원인 달은 "-"로 표시되어 있어 0으로 취급한다.
// jina 프록시가 이 표를 내보내는 형식이 세션마다 왔다갔다한다는 걸 실측으로 확인함 — 2026-08-09에는
// 탭 구분 대신 마크다운 표(`| ... | ... |`)로 바뀐 걸 보고 정규식을 그쪽으로 고쳤는데, 이번
// 세션(2026-08-16)에 다시 순수 탭 구분(`날짜\t날짜\t금액\t금액`)으로 돌아온 걸 확인함 — Naver
// 시세 파싱(dedupeNaverHalf)처럼 사이트 쪽이 아니라 jina 렌더링 자체가 들쭉날쭉한 것으로 보여서,
// 둘 다 시도하는 방식으로 고쳤다(마크다운 표 우선 시도 → 매치 없으면 탭 구분으로 재시도).
async function fetchDistRise(slug) {
  const text = await fetchProxiedText(`https://www.riseetf.co.kr/prod/finderDetail/${slug}`);
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
        <span class="stock-dist">${stock.dist || KNOWN_CUSTOM_DIST[stock.code] ? '분배 조회 중...' : (manualDist[stock.code] ? `월배당금(직접입력) ${formatKRW(manualDist[stock.code])}` : '')}</span>
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
  // selectStock/loadDistribution이 이 캐시들을 재사용). 무료 jina 프록시가 동시 요청이 많으면
  // 실패하는 걸 확인해서, 한 번에 3종목씩만 (시세+분배 순서대로) 처리하도록 동시 개수를 제한한다.
  runWithConcurrency(list, async (stock) => {
    await loadListQuote(stock);
    await loadListDist(stock);
  }, 3);
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
    const q = await fetchQuote(stock.code);
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
  row.querySelector('.stock-quote-price').textContent = formatKRW(q.price);
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

async function loadListDist(stock) {
  if (!stock.dist && !KNOWN_CUSTOM_DIST[stock.code]) return; // 소스를 모르는 커스텀 종목(직접입력값은 렌더 시점에 이미 채워짐)은 건너뜀
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
    distEl.textContent = `최근 분배(${month}월${timing}) ${latest.amount}원${rateText}`;
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
    const matches = await searchEtfByName(input);
    if (matches.length === 0) {
      els.addStockStatus.textContent = '❌ 일치하는 종목을 찾을 수 없습니다.';
    } else if (matches.length === 1) {
      await addStockByCode(matches[0].code);
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
    <button type="button" class="stock-search-item" data-code="${m.code}">
      <span class="stock-search-name">${m.name}</span>
      <span class="stock-search-code">${m.code}</span>
    </button>
  `).join('');
  els.stockSearchResults.style.display = 'flex';
  els.stockSearchResults.querySelectorAll('.stock-search-item').forEach((btn) => {
    btn.addEventListener('click', () => addStockByCode(btn.dataset.code));
  });
}

async function addStockByCode(code) {
  if (allStocks().some((s) => s.code === code)) {
    els.addStockStatus.textContent = '이미 목록에 있는 종목입니다.';
    return;
  }
  els.btnConfirmAddStock.disabled = true;
  els.addStockStatus.textContent = '종목 확인 중...';
  try {
    const { name, quote: q } = await fetchNaverPage(code);
    if (!name || !q) throw new Error('종목을 찾을 수 없습니다. 종목코드를 확인해주세요.');
    els.addStockStatus.textContent = '분배 소스 확인 중...';
    const dist = await deriveKnownDist(code, name);
    customStocks.push({ code, name, issuer: dist ? ISSUER_LABELS[dist.type] : '직접 추가', custom: true, dist });
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
    const q = await fetchQuote(stock.code);
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
  els.totalValue.textContent = valid ? formatKRW(shares * quote.price) : '-';
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
    els.divStatus.textContent = '';
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
  els.metaTotalValue.textContent = quote ? formatKRW(shares * quote.price) : '-';
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
        <span class="yearly-month">${d.basicDate.slice(5)}</span>
        <span class="yearly-per-share">${d.amount}원(옵션${d.amount - d.taxAmount}·배당${d.taxAmount})</span>
        <span class="yearly-amount">${formatKRW(postTax)}</span>
      </div>
    `);
  });

  if (chron.length === 0) {
    els.yearlyList.innerHTML = '<p class="yearly-empty">데이터 없음</p>';
    els.yearlySummary.innerHTML = '';
    return;
  }

  els.yearlyList.innerHTML = rows.join('');

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
