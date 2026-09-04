/**
 * scripts/report-fragments.ts — EV-3 shared client-JS render fragments.
 * ---------------------------------------------------------------------------
 * The step<->criterion side-by-side render functions, extracted VERBATIM from
 * `render-eval-report.ts` so BOTH the eval report AND the `*review` UI
 * (`build-review-ui.ts`) emit the identical browser-side renderer.
 *
 * `SIDE_BY_SIDE_FRAGMENT_JS` is the BYTE-IDENTICAL block (`cvRefs` +
 * `critiqueBlock` + `sideBySide` — the latter carrying its local
 * `refExaminesStep` + `covEntry`). render-eval-report splices it into its
 * client script IN PLACE, so the report's emitted HTML is unchanged (guarded by
 * the render-eval-report byte-identity tests + a before/after HTML diff).
 *
 * The fragment is provider-of-record for the render logic; its runtime deps
 * (`esc`, `resRouting`, `resBadge`, and the globals `C` / `RES`) are
 * supplied by whichever host script embeds it (render-eval-report defines them
 * above the splice; the review UI defines compatible copies — see
 * `REVIEW_SIDE_BY_SIDE_DEPS_JS`).
 *
 * `STEP_ROW_FRAGMENT_JS` is the review-UI VIRTUALIZATION mirror: standalone
 * `refExaminesStepR` / `covEntryR` / `stepRowR` that emit ONE step triplet
 * with markup IDENTICAL to `sideBySide`'s per-step output — so the review UI
 * can window a 1,686-step card without materializing the whole DOM. A drift
 * guard (`tests/report-fragments.test.ts`) evaluates both paths and asserts the
 * per-step HTML matches, so the mirror can never silently diverge from the
 * frozen fragment.
 */

/**
 * BYTE-IDENTICAL extraction of the eval report's `cvRefs` + `critiqueBlock` +
 * `sideBySide` client functions (`sideBySide` contains its local
 * `refExaminesStep` + `covEntry`). Spliced verbatim by render-eval-report and
 * reused by the review UI. DO NOT EDIT — regenerate from render-eval-report if
 * that block ever changes, and re-verify byte-identity.
 */
export const SIDE_BY_SIDE_FRAGMENT_JS = `function cvRefs(refs){if(!refs||!refs.length)return '';
  return '<div class="cvrefs">'+refs.map(function(rf){var s=(typeof rf==='string')?rf:[rf.obs,rf.path,rf.value].filter(Boolean).join(' · ');return s?'<span class="cvref">'+esc(s)+'</span>':'';}).join('')+'</div>';}
function critiqueBlock(cvs){if(!cvs||!cvs.length)return '';
  var order={fail:0,uncertain:1,indeterminate:1,pass:2,na:3};
  var rows=cvs.slice().sort(function(a,b){return (order[a.result]==null?9:order[a.result])-(order[b.result]==null?9:order[b.result]);}).map(function(v){
    var res=v.result||'na';var disp=res==='uncertain'?'indeterminate':res;
    var conf=(v.confidence!=null)?'<span class="cvconf">conf '+esc(v.confidence)+(v.confidenceBand?' · '+esc(v.confidenceBand):'')+'</span>':'';
    var crit=v.critique?'<div class="cvcrit">'+esc(v.critique)+'</div>':'<div class="cvcrit dim">— no critique recorded for this criterion</div>';
    return '<div class="cvrow '+esc(res)+'"><div class="cvh"><span class="cvb '+esc(res)+'">'+esc(disp)+'</span><span class="cvid">'+esc(v.criterionId||'')+'</span>'+conf+'</div>'+crit+cvRefs(v.refs)+'</div>';}).join('');
  return '<div class="ctx cvblock"><div class="ctx-h">◇ how the judge reasoned — per-criterion verdict · critique-before-verdict · grounding refs ('+cvs.length+')</div><div class="cvbody">'+rows+'</div></div>';}
function sideBySide(d){var ctx=d.context||{};
  // Gap A — the §2 "input + scenario" cell renders the RAW triggering INPUT (the
  // thing that fired the agent) ABOVE the judge's scenario LABEL. Long inputs
  // collapse into a <details> (lean, no JS) so the cell stays compact; short ones
  // render inline (clamped). ABSENT input ⇒ the cell shows the scenario alone (or
  // "—"). Font stays at the --fs-2xs (11px) floor + brand mono.
  var inputCell=function(raw,scen){
    var sc=scen?'<div class="iscn">scenario · '+esc(scen)+'</div>':'';
    if(!raw)return (scen?'<div class="ival">'+esc(scen)+'</div>':'—');
    var long=String(raw).length>180;
    var body=long
      ? '<details class="iexp"><summary>raw input · '+String(raw).length+' chars</summary><pre class="iraw">'+esc(raw)+'</pre></details>'
      : '<pre class="iraw clamp">'+esc(raw)+'</pre>';
    return body+sc;};
  var refStr=function(rf){if(!rf)return '';if(typeof rf==='string')return rf;return [rf.obs,rf.path,rf.value].filter(Boolean).join(':');};
  // UI-4 — surface the judge's REASONING (why the verdict + why the exit-states were
  // concluded) from the EXISTING judge walk: an ordered why-chain band + the decide/bind
  // text inlined where it explains a conclusion. No emit-contract change — read-only over
  // the judge_steps already on the verdict file.
  var KORD={gather:0,context:1,examine:2,detect:3,bind:4,ground:5,critique:6,decide:7,verify:8};
  var allJs=(d.judgeSteps||[]).slice();
  var stepText=function(kind){return allJs.filter(function(s){return s.kind===kind;}).map(function(s){return s.text||'';}).filter(Boolean).join(' · ');};
  var decideWhy=stepText('decide')||stepText('critique');
  var stateWhy=[stepText('bind'),stepText('gather')].filter(Boolean).join(' · ');
  var chainSteps=allJs.slice().sort(function(a,b){var x=KORD[a.kind];var y=KORD[b.kind];return (x==null?9:x)-(y==null?9:y);});
  var whyChain=chainSteps.length?('<div class="ctx whychain"><div class="ctx-h">◇ judge reasoning — full why-chain (gather → bind → ground → decide)</div><div class="wc-body">'+chainSteps.map(function(s){var rs=refStr(s.ref);return '<div class="jstep"><span class="k '+esc(s.kind)+'">'+esc(s.kind)+'</span><span class="t">'+esc(s.text||'')+(rs?' <span class=ref>'+esc(rs)+'</span>':'')+'</span></div>';}).join('')+'</div></div>'):'';
  var verdictWhy=decideWhy?('<div class="band whyverdict"><div class="bh" style="color:var(--primary-soft)">◇ why this verdict</div><div class="wv-t">'+esc(decideWhy)+'</div></div>'):'';
  // -- §2 judge lane = per-step EVAL COVERAGE --
  // The judge lane (.step-r) used to filter judgeSteps by anchor === a.n -- but
  // judges never emit an anchor, so EVERY step rendered a bare dash. Instead we
  // map each agent step -> the per-criterion verdicts (d.criterionVerdicts) whose
  // grounding refs EXAMINED that step: a precise ref.obs === step.obs match plus
  // the tool-name fallback (ref.path === 'name' && ref.value === step.tool).
  // Each examining criterion renders one compact entry -- result + CODE/JUDGE tag
  // + criterionId + the judge reasoning (critique). A step no criterion references
  // says 'not examined by any eval' (honest), never a bare dash. Any judge step
  // that DOES carry a real anchor is still honored (future-proof).
  var cvAll=(d.criterionVerdicts||[]);
  var refExaminesStep=function(rf,a){
    if(!rf||typeof rf==='string')return false;
    if(a.obs&&rf.obs&&String(rf.obs)===String(a.obs))return true;
    if(rf.path==='name'&&rf.value!=null&&a.tool&&String(rf.value)===String(a.tool))return true;
    return false;};
  var covEntry=function(v,a){
    var res=v.result||'na';var disp=res==='uncertain'?'indeterminate':res;
    // the router carries TWO vocabularies: matrix-derived ('deterministic') and
    // mined ('code-based'); 'hybrid' is shared. A '[code-eval ...]'-prefixed critique
    // is the deterministic-logic fallback when the method is unset.
    var method=((typeof C!=='undefined'&&C[v.criterionId])||{}).m||'';
    var isCode=method==='deterministic'||method==='code-based'||method==='hybrid'||String(v.critique||'').trim().indexOf('[code-eval')===0;
    var tag=method==='hybrid'?'HYBRID':(isCode?'CODE':'JUDGE');
    var matched=(v.refs||[]).filter(function(rf){return typeof rf!=='string'&&refExaminesStep(rf,a);});
    var crit=v.critique?esc(v.critique):'<span class="dim">— no critique recorded</span>';
    return '<div class="jcov '+esc(res)+'"><div class="jcov-h"><span class="cvb '+esc(res)+'">'+esc(disp)+'</span><span class="jm '+(isCode?'code':'judge')+'" title="'+(isCode?'deterministically checked by a code-eval (not LLM-judged)':'reasoned by the LLM judge')+'">'+esc(tag)+'</span><span class="jcid">'+esc(v.criterionId||'')+'</span></div><div class="jcrit">'+crit+'</div>'+cvRefs(matched)+'</div>';};
  var rowsHtml='';(d.agentSteps||[]).forEach(function(a){
    // future-proof: a judge step that carries a REAL anchor still renders.
    var js=(d.judgeSteps||[]).filter(function(s){return s.anchor!=null&&String(s.anchor)===String(a.n)&&s.kind!=='context';});
    var anchoredHtml=js.map(function(s){var rs=refStr(s.ref);return '<div class="jstep"><span class="k '+esc(s.kind)+'">'+esc(s.kind)+'</span><span class="t">'+esc(s.text||'')+' '+(rs?'<span class=ref>'+esc(rs)+'</span>':'')+'</span></div>';}).join('');
    var examiners=cvAll.filter(function(v){return (v.refs||[]).some(function(rf){return refExaminesStep(rf,a);});});
    var covHtml=examiners.map(function(v){return covEntry(v,a);}).join('');
    var jhtml=anchoredHtml+covHtml;
    if(!jhtml)jhtml='<div class="jstep noexam"><span class="t">— not examined by any eval</span></div>';
    rowsHtml+='<div class="step-l"><div class="evb"><div class="top"><span class="tool">'+esc(a.tool||'')+'</span><span class="st '+esc(a.status||'')+'">'+esc(a.status||'')+'</span></div><div class="det">'+esc(a.detail||'')+'</div></div></div><div class="node '+esc(a.status||'')+'"><div class="ln"></div><div class="n">'+esc(a.n)+'</div><div class="ln"></div></div><div class="step-r"><div class="evb r">'+jhtml+'</div></div>';});
  var h=d.health||{};
  var sp=d.subjectProfile;
  var spHtml=sp?'<div class="ctx"><div class="ctx-h">◇ judge · subject profile (M1) · '+esc(sp.provenance||'')+'</div><div class="ctx-g"><div class="ctx-c"><div class="l">identity</div><div class="v">'+esc(sp.identity||'—')+'</div></div><div class="ctx-c"><div class="l">purpose</div><div class="v">'+esc(sp.purpose||'—')+'</div></div><div class="ctx-c"><div class="l">scope · harness</div><div class="v">'+esc((sp.scope||'—'))+' · harness: '+esc(sp.harness||'—')+'</div></div></div></div>':'';
  var u=d.understanding;
  var uHtml=u?'<div class="band"><div class="bh" style="color:var(--cyan)">◇ node-0 GATHER — understanding (M2)</div><div class="re-rephrase" style="margin-top:4px">“'+esc(u.rephrase||'')+'”</div></div>':'';
  var et=d.expectedTrajectory||[];
  var etHtml=et.length?'<div class="band"><div class="bh" style="color:var(--primary-soft)">◇ node-0.5 EXPECTED-TRAJECTORY (M3) — how it SHOULD have acted</div><ol class="re-ul" style="margin-top:4px">'+et.map(function(s,i){return '<li><b>'+esc(s.step||i+1)+'.</b> '+esc(s.expected||'')+(s.rationale?' <span class=re-rat>— '+esc(s.rationale)+'</span>':'')+'</li>';}).join('')+'</ol></div>':'';
  return '<div class="drillbox"><div style="display:flex;gap:9px;align-items:center;flex-wrap:wrap;margin-bottom:6px"><b class="mono">'+esc(d.traceId)+'</b><span class="chip">'+esc(d.route||'all')+'</span><span class="verd '+(d.verdict=='FAIL'?'fail':d.verdict=='PASS'?'pass':'inc')+'">'+esc(d.verdict)+'</span></div>'+
    resRouting(d.res||'judge-walk')+
    spHtml+
    verdictWhy+
    critiqueBlock(d.criterionVerdicts)+
    '<div class="ctx"><div class="ctx-h">◇ judge · gather context</div><div class="ctx-g"><div class="ctx-c"><div class="l">harness</div><div class="v">'+esc(ctx.harness||'—')+'</div></div><div class="ctx-c"><div class="l">input + scenario</div><div class="v">'+inputCell(d.input,ctx.scenario)+'</div></div><div class="ctx-c"><div class="l">exit states</div><div class="v">'+esc(ctx.exitStates||'—')+(stateWhy?'<div class="why-note"><span class="ref">why concluded:</span> '+esc(stateWhy)+'</div>':'')+'</div></div></div></div>'+
    whyChain+
    uHtml+etHtml+
    '<div class="lanehdr"><div class="a">target agent — what it did</div><div class="x">step</div><div class="j">judge — eval coverage (which criteria examined this step)</div></div>'+
    '<div class="grid2">'+rowsHtml+'<div class="band loc"><div class="bh">↯ localize (root, not symptom)</div><div style="font-size:var(--fs-sm);margin-top:4px">'+esc(d.localize||'—')+'</div></div></div>'+
    '<div class="health"><div class="hc"><div class="l">context</div><div class="v good">'+(h.contextGathered?'✓':'—')+'</div></div><div class="hc"><div class="l">grounded</div><div class="v good">'+esc(h.grounded||0)+'</div></div><div class="hc"><div class="l">assumed</div><div class="v '+((h.assumed||0)>0?'warn':'good')+'">'+esc(h.assumed||0)+'</div></div><div class="hc"><div class="l">root vs symptom</div><div class="v good">'+(h.stoppedAtSymptom?'symptom':'✓ root')+'</div></div></div></div>';}`;

/**
 * The runtime deps the extracted `sideBySide` needs — `esc` / `resBadge` /
 * `resRouting` — copied BYTE-IDENTICALLY from render-eval-report's client script
 * so the reused `sideBySide` behaves identically wherever it is embedded. The
 * review UI embeds these (render-eval-report already defines them above its own
 * splice). `RES` may be an empty map in the review UI — `resRouting`/`resBadge`
 * degrade to '' when a resolution key is absent.
 */
export const REVIEW_SIDE_BY_SIDE_DEPS_JS = `function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function resBadge(res){var m=RES[res];if(!m)return '';return '<span class="resbadge '+m.cls+'" title="'+esc(m.routing)+'">'+esc(m.badge)+'</span>';}
function resRouting(res){var m=RES[res];if(!m)return '';return '<div class="routing '+m.cls+'"><span class="routing-k">resolution</span><span class="routing-b '+m.cls+'">'+esc(m.badge)+'</span><span class="routing-v">'+esc(m.routing)+'</span></div>';}`;

/**
 * The review-UI VIRTUALIZATION mirror. `stepRowR` emits ONE step triplet
 * (`.step-l` + `.node` + `.step-r`) whose markup is CHARACTER-IDENTICAL to the
 * per-step output of the frozen `sideBySide` (compare render-eval-report's
 * `rowsHtml` loop). This lets the review UI window a 1,686-step card — rendering
 * only the visible slice — instead of materializing the whole DOM (the EV-3
 * wall). `refExaminesStepR` / `covEntryR` mirror `sideBySide`'s local
 * `refExaminesStep` / `covEntry`. Depends on `esc` + `cvRefs` (from the deps +
 * the frozen fragment). The drift guard in `tests/report-fragments.test.ts`
 * evaluates both paths and asserts equality, so this mirror can never diverge.
 */
export const STEP_ROW_FRAGMENT_JS = `function refStrR(rf){if(!rf)return '';if(typeof rf==='string')return rf;return [rf.obs,rf.path,rf.value].filter(Boolean).join(':');}
function refExaminesStepR(rf,a){
  if(!rf||typeof rf==='string')return false;
  if(a.obs&&rf.obs&&String(rf.obs)===String(a.obs))return true;
  if(rf.path==='name'&&rf.value!=null&&a.tool&&String(rf.value)===String(a.tool))return true;
  return false;}
function covEntryR(v,a){
  var res=v.result||'na';var disp=res==='uncertain'?'indeterminate':res;
  var method=((typeof C!=='undefined'&&C&&C[v.criterionId])||{}).m||'';
  var isCode=method==='deterministic'||method==='code-based'||method==='hybrid'||String(v.critique||'').trim().indexOf('[code-eval')===0;
  var tag=method==='hybrid'?'HYBRID':(isCode?'CODE':'JUDGE');
  var matched=(v.refs||[]).filter(function(rf){return typeof rf!=='string'&&refExaminesStepR(rf,a);});
  var crit=v.critique?esc(v.critique):'<span class="dim">— no critique recorded</span>';
  return '<div class="jcov '+esc(res)+'"><div class="jcov-h"><span class="cvb '+esc(res)+'">'+esc(disp)+'</span><span class="jm '+(isCode?'code':'judge')+'" title="'+(isCode?'deterministically checked by a code-eval (not LLM-judged)':'reasoned by the LLM judge')+'">'+esc(tag)+'</span><span class="jcid">'+esc(v.criterionId||'')+'</span></div><div class="jcrit">'+crit+'</div>'+cvRefs(matched)+'</div>';}
function stepRowInnerR(a,cvAll,judgeSteps){
  var js=(judgeSteps||[]).filter(function(s){return s.anchor!=null&&String(s.anchor)===String(a.n)&&s.kind!=='context';});
  var anchoredHtml=js.map(function(s){var rs=refStrR(s.ref);return '<div class="jstep"><span class="k '+esc(s.kind)+'">'+esc(s.kind)+'</span><span class="t">'+esc(s.text||'')+' '+(rs?'<span class=ref>'+esc(rs)+'</span>':'')+'</span></div>';}).join('');
  var examiners=(cvAll||[]).filter(function(v){return (v.refs||[]).some(function(rf){return refExaminesStepR(rf,a);});});
  var covHtml=examiners.map(function(v){return covEntryR(v,a);}).join('');
  var jhtml=anchoredHtml+covHtml;
  if(!jhtml)jhtml='<div class="jstep noexam"><span class="t">— not examined by any eval</span></div>';
  return '<div class="step-l"><div class="evb"><div class="top"><span class="tool">'+esc(a.tool||'')+'</span><span class="st '+esc(a.status||'')+'">'+esc(a.status||'')+'</span></div><div class="det">'+esc(a.detail||'')+'</div></div></div><div class="node '+esc(a.status||'')+'"><div class="ln"></div><div class="n">'+esc(a.n)+'</div><div class="ln"></div></div><div class="step-r"><div class="evb r">'+jhtml+'</div></div>';}
function stepExaminedByR(a,cvAll){return (cvAll||[]).some(function(v){return (v.refs||[]).some(function(rf){return refExaminesStepR(rf,a);});});}`;
