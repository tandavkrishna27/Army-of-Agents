const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {chromium}=require(require.resolve('@playwright/test',{paths:[process.cwd()]}));
const root=path.join(process.cwd(),'.worktrees/universe-interface/docs/architecture/commander-canvas/evidence/first-batch-design-2026-09-13');
const src=fs.readFileSync(path.join(root,'state-study.html'),'utf8');
(async()=>{const browser=await chromium.launch();const page=await browser.newPage();await page.route('**/*',r=>r.abort());const errors=[];page.on('pageerror',e=>errors.push(e.message));const results=[];
for(const [width,height,scale] of [[1440,900,1],[1024,768,1],[390,844,1],[390,844,2]]){
await page.goto('about:blank');await page.setViewportSize({width,height});await page.emulateMedia({reducedMotion:scale===2?'reduce':'no-preference'});await page.setContent(src);if(scale===2)await page.addStyleTag({content:':root{font-size:32px}'});
for(const state of ['loading','failure','revoked','deleted','focus','attention','empty','initial']){
await page.locator('select').selectOption(state);await page.waitForTimeout(80);
const check=await page.evaluate(()=>{const w=document.querySelector('.workspace').getBoundingClientRect();const panel=document.querySelector('.panel'),head=panel.querySelector('header'),bottom=document.querySelector('.bottom'),question=document.querySelector('.question');const b=e=>e.getBoundingClientRect();const overlap=(a,b)=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;const visible=e=>getComputedStyle(e).display!=='none';return {horizontalOverflow:document.documentElement.scrollWidth>innerWidth+1,headerFits:!visible(panel)||(b(head).left>=w.left&&b(head).right<=w.right&&b(head).bottom<=w.bottom),captionQuestionOverlap:visible(bottom)&&visible(question)&&overlap(b(bottom),b(question)),privateTitleHidden:!['revoked','deleted'].includes(document.body.dataset.state)||head.textContent.trim()==='Task reference',reducedMotion:getComputedStyle(document.querySelector('.orb')).animationName,focus:document.activeElement.getAttribute('aria-label')}});
results.push({width,height,textScale:scale,state,...check});
if((width===1440&&['loading','failure','revoked','focus'].includes(state))||(width===390&&state==='attention'))await page.screenshot({path:path.join(root,`${state}-${width}-${scale}x.png`),fullPage:true});
}
}
const oldPath='C:/Users/TK/.codex/visualizations/2026/09/09/01a08745-71f3-7bb1-8a25-bfa8c3dc5f64/universe-clean-panels.html';const old=fs.readFileSync(oldPath);await page.goto('about:blank');await page.setViewportSize({width:1440,height:900});await page.setContent(old.toString());await page.screenshot({path:path.join(root,'available-reference.png'),fullPage:true});
const report={browser:await browser.version(),studySha256:crypto.createHash('sha256').update(src).digest('hex'),availableReference:{path:oldPath,sha256:crypto.createHash('sha256').update(old).digest('hex'),reviewProvenance:'not inferred'},results,errors};
fs.writeFileSync(path.join(root,'render-checks.json'),JSON.stringify(report,null,2));await browser.close();console.log(JSON.stringify({cases:results.length,issues:results.filter(x=>x.horizontalOverflow||!x.headerFits||x.captionQuestionOverlap||!x.privateTitleHidden||(x.textScale===2&&x.reducedMotion!=='none')),errors},null,2));})().catch(e=>{console.error(e);process.exit(1)});
