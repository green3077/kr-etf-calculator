const TAX_RATE = 0.154; // 배당소득세(14%) + 지방소득세(1.4%)
const TOTAL_SCREENS = 4;
const JINA_PROXY = 'https://r.jina.ai/';

let currentScreen = 1;
let selectedStock = null;
let quote = null; // { price, diff, pct, date }
let distList = null; // 선택된 종목의 월별 분배 내역 (최신순), fetchDistribution()의 정규화된 결과
const quoteCache = {}; // code -> { price, diff, pct } (종목 리스트에서 미리 조회해둔 값, 선택 시 재사용)
const distCache = {}; // code -> 분배 내역 배열 (종목 리스트에서 미리 조회해둔 값, 선택 시 재사용)

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

const els = {
  stockList: document.getElementById('stockList'),
  quoteCard: document.getElementById('quoteCard'),
  quoteName: document.getElementById('quoteName'),
  quotePrice: document.getElementById('quotePrice'),
  quoteDiff: document.getElementById('quoteDiff'),
  quoteStatus: document.getElementById('quoteStatus'),
  btnShowAddStock: document.getElementById('btnShowAddStock'),
  stockAddForm: document.getElementById('stockAddForm'),
  customCodeInput: document.getElementById('customCodeInput'),
  btnConfirmAddStock: document.getElementById('btnConfirmAddStock'),
  addStockStatus: document.getElementById('addStockStatus'),
  sharesTitle: document.getElementById('sharesTitle'),
  sharesSub: document.getElementById('sharesSub'),
  shares: document.getElementById('shares'),
  holdingCard: document.getElementById('holdingCard'),
  totalValue: document.getElementById('totalValue'),
  holdingCard3: document.getElementById('holdingCard3'),
  totalValue3: document.getElementById('totalValue3'),
  divTitle: document.getElementById('divTitle'),
  divPerUnit: document.getElementById('divPerUnit'),
  divStatus: document.getElementById('divStatus'),
  splitCard: document.getElementById('splitCard'),
  splitOption: document.getElementById('splitOption'),
  splitDividend: document.getElementById('splitDividend'),
  manualDivBlock: document.getElementById('manualDivBlock'),
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

async function fetchProxiedText(url) {
  const res = await fetch(JINA_PROXY + url);
  if (!res.ok) throw new Error('조회 실패');
  return res.text();
}

async function fetchDirectText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('조회 실패');
  return res.text();
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

// 사용자가 "+ 종목 코드로 추가"한 커스텀 종목은 어떤 운용사인지 몰라 dist가 비어있는 게
// 기본이지만, 실제로 확인해서 정확한 내부 ID를 찾아낸 종목은 여기 등록해두면 커스텀으로
// 추가했을 때도(localStorage에 dist 없이 저장돼 있어도) 정확한 분배금 자동조회가 된다.
// 코드로 찾아 확인하는 대로 하나씩 늘려가는 목록 — 화면의 7종목과 같은 방식.
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
async function fetchDistRise(slug) {
  const text = await fetchProxiedText(`https://www.riseetf.co.kr/prod/finderDetail/${slug}`);
  const rows = [];
  const re = /(\d{4}-\d{2}-\d{2})\t(\d{4}-\d{2}-\d{2})\t([\d,]+)\t(-|[\d,]+)/g;
  let m;
  while ((m = re.exec(text))) {
    rows.push({
      basicDate: m[1],
      payDate: m[2],
      amount: Number(m[3].replace(/,/g, '')),
      taxAmount: m[4] === '-' ? 0 : Number(m[4].replace(/,/g, '')),
    });
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

  els.btnPrev.style.display = n === 1 ? 'none' : '';
  els.navButtons.classList.toggle('centered', n === 1 || n === 4);
  els.btnNext.textContent = n === TOTAL_SCREENS ? '처음으로' : '다음';

  currentScreen = n;
  updateNextEnabled();

  if (n === 2) renderHoldingCard();
  if (n === 3) loadDistribution();
  if (n === 4) renderResult();
}

function updateNextEnabled() {
  let valid = true;
  if (currentScreen === 1) valid = !!(selectedStock && quote);
  else if (currentScreen === 2) valid = Number(els.shares.value) > 0;
  else if (currentScreen === 3) valid = Number(els.divPerUnit.value) > 0;
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
  els.quoteCard.style.display = 'none';
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
        <span class="stock-dist">${stock.dist || KNOWN_CUSTOM_DIST[stock.code] ? '분배 조회 중...' : ''}</span>
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

async function loadListDist(stock) {
  if (!stock.dist && !KNOWN_CUSTOM_DIST[stock.code]) return; // 소스를 모르는 커스텀 종목은 조용히 건너뜀
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
    distEl.textContent = `최근 분배(${month}월) ${latest.amount}원${rateText}`;
  } catch (err) {
    if (distEl) distEl.textContent = '분배 조회 실패';
  }
}

// ---------- 종목 직접 추가 ----------
els.btnShowAddStock.addEventListener('click', () => {
  const showing = els.stockAddForm.style.display !== 'none';
  els.stockAddForm.style.display = showing ? 'none' : 'flex';
  els.addStockStatus.textContent = '';
  if (!showing) els.customCodeInput.focus();
});

els.btnConfirmAddStock.addEventListener('click', async () => {
  const code = els.customCodeInput.value.trim();
  if (!code) return;
  if (allStocks().some((s) => s.code === code)) {
    els.addStockStatus.textContent = '이미 목록에 있는 종목입니다.';
    return;
  }
  els.btnConfirmAddStock.disabled = true;
  els.addStockStatus.textContent = '종목 확인 중...';
  try {
    const { name, quote: q } = await fetchNaverPage(code);
    if (!name || !q) throw new Error('종목을 찾을 수 없습니다. 종목코드를 확인해주세요.');
    customStocks.push({ code, name, issuer: '직접 추가', custom: true });
    saveCustomStocks(customStocks);
    quoteCache[code] = q;
    els.customCodeInput.value = '';
    els.addStockStatus.textContent = `✅ "${name}" 추가되었습니다.`;
    els.stockAddForm.style.display = 'none';
    renderStockList();
  } catch (err) {
    els.addStockStatus.textContent = '❌ ' + err.message;
  } finally {
    els.btnConfirmAddStock.disabled = false;
  }
});

function removeCustomStock(code) {
  customStocks = customStocks.filter((s) => s.code !== code);
  saveCustomStocks(customStocks);
  if (selectedStock && selectedStock.code === code) {
    resetApp();
    showScreen(1);
  }
  renderStockList();
}

async function selectStock(stock, itemEl) {
  selectedStock = stock;
  distList = distCache[stock.code] || null;
  document.querySelectorAll('.stock-item').forEach((el) => el.classList.remove('selected'));
  itemEl.classList.add('selected');

  els.quoteCard.style.display = 'none';
  quote = null;
  updateNextEnabled();

  const cached = quoteCache[stock.code];
  if (cached) {
    applyQuote(stock, cached);
    return;
  }

  els.quoteStatus.textContent = '시세 조회 중...';
  try {
    const q = await fetchQuote(stock.code);
    quoteCache[stock.code] = q;
    if (selectedStock !== stock) return; // 그 사이 다른 종목을 선택함
    applyQuote(stock, q);
  } catch (err) {
    if (selectedStock !== stock) return;
    els.quoteStatus.textContent = '시세 조회 실패 — 잠시 후 다시 시도해주세요.';
  } finally {
    if (selectedStock === stock) updateNextEnabled();
  }
}

function applyQuote(stock, q) {
  quote = q;
  els.quoteName.textContent = stock.name;
  els.quotePrice.textContent = formatKRW(q.price);
  const sign = q.diff > 0 ? '+' : '';
  const cls = q.diff > 0 ? 'diff-up' : q.diff < 0 ? 'diff-down' : '';
  els.quoteDiff.innerHTML = `<span class="${cls}">${sign}${formatKRW(q.diff)} (${sign}${q.pct}%)</span>`;
  els.quoteCard.style.display = 'block';
  els.quoteStatus.textContent = '';
  updateNextEnabled();
}

// ---------- 화면 2: 보유수량 ----------
function renderHoldingCard() {
  els.sharesTitle.textContent = `${selectedStock.name} 보유 수량`;
  els.sharesSub.textContent = '보유하고 계신 주수를 입력하세요';
  updateHoldingValue();
}

// 화면 2(보유수량)와 화면 3(분배금 확인) 양쪽에 같은 보유 평가금액을 보여준다.
function updateHoldingValue() {
  const shares = Number(els.shares.value);
  const valid = shares > 0 && quote;
  const text = valid ? formatKRW(shares * quote.price) : '-';

  els.holdingCard.style.display = valid ? 'block' : 'none';
  els.totalValue.textContent = text;

  els.holdingCard3.style.display = valid ? 'block' : 'none';
  els.totalValue3.textContent = text;
}
els.shares.addEventListener('input', () => {
  updateHoldingValue();
  updateNextEnabled();
});

// ---------- 화면 3: 분배금 확인 ----------
async function loadDistribution() {
  updateHoldingValue();
  els.splitCard.style.display = 'none';
  els.manualDivBlock.style.display = 'none';
  els.divPerUnit.readOnly = true;
  els.divPerUnit.value = '';
  els.divTitle.textContent = '분배금 확인 중';
  els.divStatus.textContent = '공식 데이터 조회 중...';
  const stock = selectedStock;

  try {
    if (!distList) distList = await fetchDistribution(stock);
    if (selectedStock !== stock) return; // 그 사이 다른 종목을 선택함
    if (!distList || distList.length === 0) throw new Error('분배 내역 없음');
    const latest = distList[0];
    els.divPerUnit.value = latest.amount;
    const optionAmt = latest.amount - latest.taxAmount;
    els.divTitle.textContent = `${latest.basicDate} 분배금`;
    els.divStatus.textContent = `실지급일 ${latest.payDate}`;
    els.splitOption.textContent = `옵션 ${formatKRW(optionAmt)}`;
    els.splitDividend.textContent = `배당 ${formatKRW(latest.taxAmount)}`;
    els.splitCard.style.display = 'block';
  } catch (err) {
    if (selectedStock !== stock) return;
    // 자동 조회가 실패한 경우에만 수동 입력으로 대체 (7종목 모두 공식 소스가 있지만, 네트워크
    // 문제 등으로 실패할 수 있음 — 이 경우 사용자가 공시를 참고해 직접 입력할 수 있게 한다).
    els.divTitle.textContent = '분배금 입력';
    els.divPerUnit.readOnly = false;
    els.divPerUnit.placeholder = '예: 200';
    els.divStatus.textContent = '자동 조회 실패 — 공시를 참고해 직접 입력해주세요.';
    els.manualDivBlock.style.display = 'block';
  } finally {
    if (selectedStock === stock) updateNextEnabled();
  }
}
els.divPerUnit.addEventListener('input', updateNextEnabled);

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
    els.resultSubtitle.textContent = rate ? `(${month}월 ${rate}% 분배)` : '';
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
  els.yearlySummary.innerHTML = `
    <div class="yearly-summary-row">
      <div class="yearly-summary-row-top">
        <span class="yearly-summary-label">${currentYear}년 합계 (${chron.length}회, 세후)</span>
        <span class="value-krw">${formatKRW(sumPostTax)}</span>
      </div>
      <div class="yearly-summary-sub-line">(옵션 ${formatKRW(sumOption)} · 배당 ${formatKRW(sumDividend)})</div>
    </div>
    <div class="yearly-summary-row">
      <div class="yearly-summary-row-top">
        <span class="yearly-summary-label">${currentYear}년 회당 평균 (세후)</span>
        <span class="value-krw">${formatKRW(avgPostTax)}</span>
      </div>
    </div>
  `;
}

renderStockList();
showScreen(1);
