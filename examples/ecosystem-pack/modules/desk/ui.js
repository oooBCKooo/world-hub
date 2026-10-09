const words = {
  zh: { title:'跨语言文本台', subtitle:'三个独立程序，通过双向 mod 桥组合。', language:'语言', path:'界面程序 → 枢纽 → JavaScript 来源 → 枢纽 → 界面程序 → 枢纽 → Python 统计 → 枢纽 → 界面程序', input:'文本来源', inputHint:'保留原文、emoji 和换行，最多 16 KiB UTF-8。', analyze:'保存来源并分析', read:'分析已保存来源', result:'Python 统计成果', points:'Unicode 码点', lines:'行数', bytes:'UTF-8 字节', receipts:'查看真实通讯回执', footer:'原文和成果由外部程序保存。枢纽只接纳、保留和转交通讯；ACK 和停止不会释放记录。', waiting:'等待操作', working:'正在抽取来源、调用 Python 并保存成果…', complete:'成果已保存', failed:'操作未完成，检查通讯或程序状态。结果可能已产生。', saved:'本实例保存的成果', revision:'来源修订', provider:'提供者', timestamp:'完成时间' },
  en: { title:'Cross-language text desk', subtitle:'Three independent programs composed through bidirectional mod bridges.', language:'Language', path:'Desk → Hub → JavaScript source → Hub → Desk → Hub → Python statistics → Hub → Desk', input:'Text source', inputHint:'Exact text, emoji and line breaks; at most 16 KiB of UTF-8.', analyze:'Save source and analyze', read:'Analyze saved source', result:'Python statistics result', points:'Unicode code points', lines:'Lines', bytes:'UTF-8 bytes', receipts:'View real communication receipts', footer:'External programs own the text and results. The Hub accepts, retains and transfers messages; ACK and stopping do not release them.', waiting:'Ready', working:'Reading the source, calling Python and saving the result…', complete:'Result saved', failed:'Operation did not finish. Check communications or program status. A result may already exist.', saved:'Results saved in this instance', revision:'Source revision', provider:'Provider', timestamp:'Completed' }
};
let language = localStorage.getItem('polyglot-language') === 'en' ? 'en' : 'zh';
let state, statusKey = 'waiting', lastError = '';
const el = id => document.getElementById(id);
function show() {
  const dictionary = words[language]; document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  document.title = dictionary.title; el('language').value = language;
  document.querySelectorAll('[data-i18n]').forEach(node => { node.textContent = dictionary[node.dataset.i18n]; });
  el('status').textContent = dictionary[statusKey] + (lastError ? ` (${lastError})` : '');
  const result = state?.results?.at(-1);
  if (!result) return;
  el('points').textContent = result.output.codePoints; el('lines').textContent = result.output.lines; el('bytes').textContent = result.output.utf8Bytes;
  el('hash').textContent = 'SHA-256: ' + result.output.sha256;
  el('saved').textContent = `${dictionary.saved}: ${state.results.length} · ${dictionary.revision}: ${result.sourceRevision}`;
  el('receipts').textContent = JSON.stringify({ [dictionary.provider]: result.provider, [dictionary.timestamp]: result.completedAt, receipts: result.receipts }, null, 2);
}
el('language').addEventListener('change', () => { language = el('language').value; localStorage.setItem('polyglot-language', language); show(); });
async function refresh() {
  const response = await fetch('/state', { cache:'no-store' }); state = await response.json();
  if (!response.ok || state.ok !== true) throw new Error(state.error?.code ?? 'STATE_UNAVAILABLE');
  show(); return state;
}
async function analyze(saveText) {
  el('analyze').disabled = true; el('read').disabled = true; statusKey = 'working'; lastError = ''; show();
  try {
    const response = await fetch('/analyze', { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(saveText ? { text:el('text').value } : {}) });
    const answer = await response.json(); if (!response.ok || answer.ok !== true) throw new Error(answer.error?.code ?? 'RESULT_UNKNOWN');
    await refresh(); el('text').value = answer.result.text; statusKey = 'complete';
  } catch (error) { statusKey = 'failed'; lastError = error.message; }
  finally { el('analyze').disabled = false; el('read').disabled = false; show(); }
}
el('analyze').addEventListener('click', () => void analyze(true)); el('read').addEventListener('click', () => void analyze(false));
show(); refresh().then(current => { if (current.results.length) el('text').value = current.results.at(-1).text; })
  .catch(error => { statusKey = 'failed'; lastError = error.message; show(); });
