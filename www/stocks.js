// 국내 상장 커버드콜 계열 ETF 목록. 7종목 모두 운용사 공식 데이터에서
// 월별 분배금을 "옵션프리미엄(비과세) / 배당수익(과세)"으로 정확히 분리해서 가져온다
// (dist.type별로 각 운용사 공식 API/페이지 구조가 달라 app.js의 fetchDistribution()에서 분기 처리).
const STOCKS = [
  { code: '498400', name: 'KODEX 200타겟위클리커버드콜', issuer: '삼성자산운용', dist: { type: 'samsung', id: '2ETFP4' } },
  { code: '0219E0', name: 'KODEX 200커버드콜액티브', issuer: '삼성자산운용', dist: { type: 'samsung', id: '2ETFV8' } },
  { code: '472150', name: 'TIGER 배당커버드콜액티브', issuer: '미래에셋자산운용', dist: { type: 'mirae', ksdFund: 'KR7472150002', jongCode: '472150' } },
  { code: '0167B0', name: 'SOL 200타겟위클리커버드콜', issuer: '신한자산운용', dist: { type: 'sol', fundCd: '211107' } },
  { code: '475720', name: 'RISE 200위클리커버드콜', issuer: 'KB자산운용', dist: { type: 'rise', slug: '44G3' } },
  { code: '0177R0', name: 'TIGER 반도체TOP10커버드콜액티브', issuer: '미래에셋자산운용', dist: { type: 'mirae', ksdFund: 'KR70177R0000', jongCode: '0177R0' } },
  { code: '0199C0', name: 'ACE 고배당주Plus커버드콜액티브', issuer: '한국투자신탁운용', dist: { type: 'ace', fundCode: 'K55101EV6285' } },
];
