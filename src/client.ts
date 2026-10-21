import { rateLabel, promotionNote, promotionWindow } from "./core/rate.ts";

declare const window: Window & { __ModuleLoader__: any };
window.__ModuleLoader__.load({
  id: "dsh-channel-hub",
  factory: (require: any) => {
    const React = require("react");
    const h = React.createElement;
    const { useState, useEffect, useRef } = React;
    const css = `
.chub{
  --chub-text:var(--dsw-alias-label-primary,var(--text-primary,inherit));
  --chub-text-2:var(--dsw-alias-label-secondary,#6b7280);
  --chub-text-3:var(--dsw-alias-label-tertiary,#9ca3af);
  --chub-line:var(--dsw-alias-border-l2,rgba(128,128,128,.28));
  --chub-line-soft:var(--dsw-alias-border-l1,rgba(128,128,128,.16));
  --chub-layer-1:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));
  --chub-layer-2:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.09));
  --chub-layer-3:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.13));
  --chub-accent:var(--dsw-alias-state-business-primary,#5785dd);
  --chub-ok:var(--dsw-alias-state-success-primary,#2f9e6b);
  --chub-warn:var(--dsw-alias-state-warning-primary,#d6922f);
  --chub-err:var(--dsw-alias-state-error-primary,#d55b5b);
  display:flex;
  flex-direction:column;
  gap:16px;
  width:100%;
  max-width:1080px;
  margin:0 auto;
  padding:4px 2px 28px;
  box-sizing:border-box;
  color:var(--chub-text);
  font-size:15px;
  line-height:1.55;
}
.chub *{box-sizing:border-box}
.chub ::selection{background:color-mix(in srgb,var(--chub-accent) 30%,transparent)}
.chub h2,.chub h3,.chub h4,.chub p{margin:0}
.chub h2{font-size:27px;line-height:1.2;font-weight:760;letter-spacing:-.02em}
.chub h3{font-size:16px;line-height:1.35;font-weight:680}
.chub h4{font-size:14.5px;line-height:1.4;font-weight:660}
.chub a{color:var(--chub-accent);text-decoration:none}
.chub a:hover{text-decoration:underline}
.chub :focus-visible{outline:2px solid color-mix(in srgb,var(--chub-accent) 72%,transparent);outline-offset:2px}
.chub-hero{
  position:relative;
  display:flex;
  flex-direction:column;
  gap:16px;
  padding:22px 24px 20px;
  overflow:hidden;
  border:1px solid var(--chub-line-soft);
  border-radius:20px;
  background:
    radial-gradient(120% 160% at 100% 0%,color-mix(in srgb,var(--chub-accent) 14%,transparent),transparent 58%),
    linear-gradient(165deg,var(--chub-layer-2),var(--chub-layer-1));
  box-shadow:inset 0 1px 0 color-mix(in srgb,#fff 8%,transparent);
}
.chub-hero::after{
  content:"";
  position:absolute;
  right:-90px;
  top:-110px;
  width:280px;
  height:280px;
  border-radius:50%;
  border:1px solid color-mix(in srgb,var(--chub-accent) 22%,transparent);
  pointer-events:none;
}
.chub-pagehead{display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap;position:relative;z-index:1}
.chub-headline{display:flex;flex-direction:column;gap:5px;min-width:0;flex:1 1 420px}
.chub-eyebrow{font-size:12px;line-height:1.4;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--chub-accent)}
.chub-headline h2{background:linear-gradient(110deg,var(--chub-text),color-mix(in srgb,var(--chub-accent) 72%,var(--chub-text)));-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.chub-sub{margin:0;max-width:66ch;font-size:14px;line-height:1.65;color:var(--chub-text-2)}
.chub-pills{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-left:auto;padding-bottom:2px}
.chub-pill{
  display:inline-flex;
  align-items:center;
  gap:6px;
  padding:4px 9px;
  border:1px solid var(--chub-line-soft);
  border-radius:999px;
  background:color-mix(in srgb,var(--chub-layer-2) 78%,transparent);
  color:var(--chub-text-2);
  font-size:12.5px;
  line-height:1.5;
  font-weight:560;
  white-space:nowrap;
}
.chub-dot{width:6px;height:6px;border-radius:50%;background:var(--chub-text-3);flex:none}
.chub-pill.ok{color:var(--chub-ok);border-color:color-mix(in srgb,var(--chub-ok) 28%,transparent);background:color-mix(in srgb,var(--chub-ok) 8%,transparent)}
.chub-pill.ok .chub-dot{background:var(--chub-ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--chub-ok) 14%,transparent)}
.chub-pill.err{color:var(--chub-err);border-color:color-mix(in srgb,var(--chub-err) 30%,transparent);background:color-mix(in srgb,var(--chub-err) 8%,transparent)}
.chub-pill.err .chub-dot{background:var(--chub-err)}
.chub-ministats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;position:relative;z-index:1}
.chub-mini{display:flex;flex-direction:column;gap:1px;min-width:0;padding:8px 10px;border:1px solid var(--chub-line-soft);border-radius:11px;background:color-mix(in srgb,var(--chub-layer-1) 76%,transparent)}
.chub-mini span{font-size:11.5px;line-height:1.4;font-weight:650;letter-spacing:.08em;text-transform:uppercase;color:var(--chub-text-3)}
.chub-mini b{font-size:19px;line-height:1.25;font-weight:700;letter-spacing:-.01em;font-variant-numeric:tabular-nums}
.chub-mini i{font-style:normal;font-size:12px;line-height:1.4;color:var(--chub-text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chub-navbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.chub-tabs{display:inline-flex;align-items:center;gap:3px;padding:4px;border:1px solid var(--chub-line-soft);border-radius:12px;background:var(--chub-layer-1)}
.chub-tabs button{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  gap:6px;
  border:0;
  border-radius:8px;
  padding:6px 13px;
  background:transparent;
  color:var(--chub-text-2);
  font:inherit;
  font-size:14px;
  font-weight:600;
  line-height:1.5;
  cursor:pointer;
  transition:background .16s ease,color .16s ease,box-shadow .16s ease;
  white-space:nowrap;
}
.chub-tabs button:hover{background:color-mix(in srgb,var(--chub-layer-2) 82%,transparent);color:var(--chub-text)}
.chub-tabs button[aria-current=page]{background:var(--chub-layer-3);color:var(--chub-text);box-shadow:inset 0 1px 0 color-mix(in srgb,#fff 10%,transparent),0 1px 2px rgba(0,0,0,.08)}
.chub-tabcount{font-style:normal;font-size:12px;line-height:1;padding:3px 5px;border-radius:999px;background:color-mix(in srgb,var(--chub-accent) 14%,transparent);color:var(--chub-accent);font-variant-numeric:tabular-nums}
.chub-navacts{display:flex;align-items:center;gap:9px;margin-left:auto}
.chub-hint{font-size:12.5px;color:var(--chub-text-3);white-space:nowrap}
.chub-btn{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  gap:5px;
  border:1px solid var(--chub-line);
  border-radius:9px;
  padding:6px 11px;
  background:var(--chub-layer-2);
  color:var(--chub-text);
  font:inherit;
  font-size:14px;
  font-weight:560;
  line-height:1.5;
  cursor:pointer;
  white-space:nowrap;
  transition:background .16s ease,border-color .16s ease,color .16s ease,transform .16s ease;
}
.chub-btn:hover:not(:disabled){background:var(--chub-layer-3);border-color:color-mix(in srgb,var(--chub-accent) 38%,var(--chub-line))}
.chub-btn:active:not(:disabled){transform:translateY(1px)}
.chub-btn.primary{border-color:color-mix(in srgb,var(--chub-accent) 36%,var(--chub-line));background:color-mix(in srgb,var(--chub-accent) 13%,var(--chub-layer-1));color:var(--chub-accent)}
.chub-btn.primary:hover:not(:disabled){background:color-mix(in srgb,var(--chub-accent) 20%,var(--chub-layer-1))}
.chub-btn.ghost{border-color:transparent;background:transparent;color:var(--chub-text-2)}
.chub-btn.ghost:hover:not(:disabled){border-color:var(--chub-line-soft);background:var(--chub-layer-1);color:var(--chub-text)}
.chub-btn.danger{color:var(--chub-err)}
.chub-btn.danger:hover:not(:disabled){border-color:color-mix(in srgb,var(--chub-err) 36%,var(--chub-line));background:color-mix(in srgb,var(--chub-err) 10%,transparent)}
.chub-btn.small{padding:3px 8px;border-radius:7px;font-size:12.5px;font-weight:560}
.chub-btn:disabled{opacity:.42;cursor:not-allowed}
.chub-alert{display:flex;flex-direction:column;gap:3px;padding:10px 13px;border:1px solid var(--chub-line);border-radius:12px;background:var(--chub-layer-1)}
.chub-alert b{font-size:14px;line-height:1.5;font-weight:650}
.chub-alert p{margin:0;font-size:13.5px;line-height:1.65;color:var(--chub-text-2);overflow-wrap:anywhere}
.chub-alert a{font-size:13.5px;font-weight:600;align-self:flex-start}
.chub-alert code{padding:1px 5px;border-radius:5px;background:var(--chub-layer-2);font-size:13px}
.chub-alert.err{border-color:color-mix(in srgb,var(--chub-err) 32%,transparent);background:color-mix(in srgb,var(--chub-err) 7%,var(--chub-layer-1))}
.chub-alert.err b{color:var(--chub-err)}
.chub-alert.info{border-color:color-mix(in srgb,var(--chub-accent) 32%,transparent);background:color-mix(in srgb,var(--chub-accent) 7%,var(--chub-layer-1))}
.chub-alert.info b{color:var(--chub-accent)}
.chub-filters{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border:1px solid var(--chub-line-soft);border-radius:13px;background:var(--chub-layer-1)}
.chub-filterhead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.chub-filterhead b{font-size:13.5px;font-weight:650}
.chub-filterhead span{font-size:12.5px;color:var(--chub-text-3)}
.chub-filterrow{display:flex;align-items:flex-end;gap:8px;flex-wrap:wrap}
.chub-field{display:flex;flex-direction:column;gap:3px;flex:1 1 148px;min-width:0}
.chub-field.grow{flex:2 1 210px}
.chub-field>span{font-size:11.5px;line-height:1.4;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--chub-text-3)}
.chub-field select,.chub-field input{width:100%;min-width:0;padding:5px 8px;border:1px solid var(--chub-line);border-radius:8px;background:var(--chub-layer-2);color:var(--chub-text);font:inherit;font-size:13.5px;line-height:1.5}
.chub-field input::placeholder{color:var(--chub-text-3)}
.chub-body{display:flex;flex-direction:column;gap:14px;animation:chub-in .28s ease both}
.chub-section{display:flex;flex-direction:column;gap:10px}
.chub-sectionhead{display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap;padding-bottom:8px;border-bottom:1px solid var(--chub-line-soft)}
.chub-sectionhead>div:first-child{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 320px}
.chub-sectionhint{margin:0;font-size:13px;line-height:1.6;color:var(--chub-text-3)}
.chub-sectools{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.chub-channels{display:grid;grid-template-columns:repeat(auto-fill,minmax(380px,1fr));gap:12px;align-items:start}
.chub-channel{
  --chan-accent:var(--chub-accent);
  position:relative;
  display:flex;
  flex-direction:column;
  gap:10px;
  min-width:0;
  padding:15px 16px 13px;
  overflow:hidden;
  border:1px solid var(--chub-line-soft);
  border-radius:15px;
  background:linear-gradient(160deg,var(--chub-layer-2),var(--chub-layer-1));
  transition:border-color .18s ease,transform .18s ease,box-shadow .18s ease;
}
.chub-channel::before{content:"";position:absolute;inset:0 0 auto;height:2px;background:linear-gradient(90deg,var(--chan-accent),transparent 76%);opacity:.72}
.chub-channel[data-state=idle]::before{background:linear-gradient(90deg,var(--chub-warn),transparent 76%)}
.chub-channel[data-state=err]::before{background:linear-gradient(90deg,var(--chub-err),transparent 76%)}
.chub-channel[data-state=off]::before{background:linear-gradient(90deg,var(--chub-text-3),transparent 76%)}
.chub-chanhead{display:flex;align-items:center;gap:9px;min-width:0}
.chub-chanlogo{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  width:32px;
  height:32px;
  flex:none;
  border-radius:10px;
  background:linear-gradient(145deg,color-mix(in srgb,var(--chan-accent) 82%,#fff),color-mix(in srgb,var(--chan-accent) 54%,#07111f));
  color:#fff;
  font-size:12.5px;
  font-weight:760;
  letter-spacing:.02em;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.24),0 4px 10px color-mix(in srgb,var(--chan-accent) 18%,transparent);
}
.chub-chanid{display:flex;flex-direction:column;gap:0;min-width:0;flex:1}
.chub-chanid b{font-size:15px;line-height:1.45;font-weight:680;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chub-chanid span{font-size:12px;line-height:1.45;color:var(--chub-text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chub-chanstate{display:inline-flex;align-items:center;gap:4px;flex:none;padding:2px 7px;border:1px solid var(--chub-line-soft);border-radius:999px;color:var(--chub-text-3);font-size:11.5px;font-weight:600;line-height:1.5;white-space:nowrap}
.chub-chanstate::before{content:"";width:4px;height:4px;border-radius:50%;background:currentColor}
.chub-channel[data-state=on] .chub-chanstate{color:var(--chub-ok);border-color:color-mix(in srgb,var(--chub-ok) 26%,transparent);background:color-mix(in srgb,var(--chub-ok) 7%,transparent)}
.chub-channel[data-state=idle] .chub-chanstate{color:var(--chub-warn);border-color:color-mix(in srgb,var(--chub-warn) 26%,transparent);background:color-mix(in srgb,var(--chub-warn) 7%,transparent)}
.chub-channel[data-state=err] .chub-chanstate{color:var(--chub-err);border-color:color-mix(in srgb,var(--chub-err) 28%,transparent);background:color-mix(in srgb,var(--chub-err) 7%,transparent)}
.chub-chanmeta{display:flex;align-items:center;gap:4px 9px;flex-wrap:wrap;padding:5px 0 1px;border-top:1px dashed var(--chub-line-soft);font-size:12px;line-height:1.5;color:var(--chub-text-3)}
.chub-chanmeta b{font-weight:650;color:var(--chub-text-2);font-variant-numeric:tabular-nums}
.chub-chanmeta .warn{color:var(--chub-warn)}
.chub-chanacts{display:flex;align-items:center;gap:5px;flex-wrap:wrap}
.chub-smsform{display:flex;flex-direction:column;gap:7px;padding:10px 11px;border:1px solid var(--chub-line-soft);border-radius:12px;background:var(--chub-layer-1)}
.chub-smsform .chub-smsfields{display:flex;gap:8px;flex-wrap:wrap}
.chub-smsform .chub-field{flex:1 1 132px}
.chub-acctlist{display:flex;flex-direction:column;gap:7px}
.chub-acct{
  display:flex;
  flex-direction:column;
  gap:7px;
  min-width:0;
  padding:9px 10px;
  border:1px solid var(--chub-line-soft);
  border-radius:11px;
  background:color-mix(in srgb,var(--chub-layer-1) 82%,transparent);
}
.chub-acct:has(input:focus-visible){border-color:color-mix(in srgb,var(--chub-accent) 48%,var(--chub-line))}
.chub-accthead{display:flex;align-items:center;gap:7px;min-width:0}
.chub-avatar{display:inline-flex;align-items:center;justify-content:center;width:23px;height:23px;flex:none;border-radius:7px;background:color-mix(in srgb,var(--chan-accent) 16%,var(--chub-layer-2));color:var(--chan-accent);font-size:11px;font-weight:720}
.chub-acctid{display:flex;flex-direction:column;gap:0;min-width:0;flex:1}
.chub-acctid b{font-size:13.5px;line-height:1.5;font-weight:640;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chub-acctid span{font-size:11.5px;line-height:1.45;color:var(--chub-text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chub-acctid i{font-style:normal}
.chub-acctid i.warn{color:var(--chub-warn)}
.chub-acctid i.err{color:var(--chub-err)}
.chub-acctbadges{display:flex;align-items:center;gap:4px;flex-wrap:wrap;justify-content:flex-end}
.chub-badge{display:inline-flex;align-items:center;padding:1px 6px;border:1px solid var(--chub-line-soft);border-radius:999px;background:var(--chub-layer-1);color:var(--chub-text-3);font-size:11px;line-height:1.5;font-weight:600;white-space:nowrap}
.chub-badge.ok{color:var(--chub-ok);border-color:color-mix(in srgb,var(--chub-ok) 24%,transparent);background:color-mix(in srgb,var(--chub-ok) 7%,transparent)}
.chub-badge.warn{color:var(--chub-warn);border-color:color-mix(in srgb,var(--chub-warn) 24%,transparent);background:color-mix(in srgb,var(--chub-warn) 7%,transparent)}
.chub-badge.err{color:var(--chub-err);border-color:color-mix(in srgb,var(--chub-err) 26%,transparent);background:color-mix(in srgb,var(--chub-err) 7%,transparent)}
.chub-acctmeta{display:flex;align-items:center;gap:3px 8px;flex-wrap:wrap;font-size:11.5px;line-height:1.5;color:var(--chub-text-3)}
.chub-acctmeta b{font-weight:650;color:var(--chub-text-2)}
.chub-acctmeta .warn{color:var(--chub-warn)}
.chub-acctmeta .err{color:var(--chub-err)}
/* 额度读数：数值与单位在宿主侧拼好（core/credits.ts），这里只排版。 */
.chub-credits{display:flex;flex-direction:column;gap:4px;min-width:0}
.chub-creditline{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;line-height:1.5;color:var(--chub-text-2)}
.chub-creditline>b{font-weight:680;font-variant-numeric:tabular-nums;color:var(--chub-text)}
.chub-creditline .chub-creditlabel{font-size:11.5px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--chub-text-3)}
.chub-creditline .err{color:var(--chub-err)}
.chub-creditline .muted{color:var(--chub-text-3)}
.chub-credittag{flex:none;padding:0 5px;border:1px solid color-mix(in srgb,var(--chan-accent) 22%,transparent);border-radius:999px;background:color-mix(in srgb,var(--chan-accent) 9%,transparent);color:color-mix(in srgb,var(--chan-accent) 66%,var(--chub-text));font-size:11px;font-weight:600;line-height:1.6;white-space:nowrap}
.chub-creditbar{height:4px;overflow:hidden;border-radius:2px;background:var(--chub-layer-3)}
.chub-creditbar>i{display:block;height:100%;border-radius:inherit;background:var(--chan-accent)}
.chub-creditbar.low>i{background:var(--chub-warn)}
.chub-creditnote{margin:0;font-size:11.5px;line-height:1.5;color:var(--chub-text-3);overflow-wrap:anywhere}
.chub-creditnote.err{color:var(--chub-err)}
.chub-pkgs{display:flex;flex-direction:column;gap:5px;padding-top:5px}
.chub-pkg{display:flex;flex-direction:column;gap:3px;min-width:0;padding:5px 7px;border-radius:7px;background:color-mix(in srgb,var(--chub-layer-2) 62%,transparent)}
.chub-pkg.off{opacity:.5}
.chub-pkghead{display:flex;align-items:baseline;gap:6px;min-width:0;font-size:11.5px;line-height:1.5;color:var(--chub-text-3)}
.chub-pkgname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--chub-text-2);font-weight:600}
.chub-pkgval{flex:none;font-variant-numeric:tabular-nums;color:var(--chub-text-2)}
.chub-pkgwhen{flex:none;font-variant-numeric:tabular-nums;color:var(--chub-text-3);white-space:nowrap}
.chub-acctacts{display:flex;align-items:center;gap:3px;flex-wrap:wrap}
.chub-inline{margin:0;font-size:12.5px;line-height:1.6;color:var(--chub-text-2);overflow-wrap:anywhere}
.chub-inline.err{color:var(--chub-err)}
.chub-inline.muted{color:var(--chub-text-3)}
.chub-models summary,.chub-fold summary{display:flex;align-items:center;gap:6px;list-style:none;cursor:pointer;color:var(--chub-text-2);font-size:12.5px;line-height:1.5}
.chub-models summary::-webkit-details-marker,.chub-fold summary::-webkit-details-marker{display:none}
.chub-models summary::before,.chub-fold summary::before{content:"›";display:inline-block;color:var(--chub-text-3);font-size:16px;line-height:1;transition:transform .15s ease;transform:translateY(-1px)}
.chub-models[open] summary::before,.chub-fold[open] summary::before{transform:rotate(90deg) translateX(-1px)}
.chub-models summary{padding:5px 7px;border:1px solid var(--chub-line-soft);border-radius:8px;background:var(--chub-layer-1)}
.chub-models summary:hover{border-color:color-mix(in srgb,var(--chan-accent) 34%,var(--chub-line))}
.chub-summaryhint{margin-left:auto;font-size:11.5px;font-weight:400;color:var(--chub-text-3);text-align:right}
.chub-modelacts{display:flex;align-items:center;gap:4px;padding:7px 2px 1px;flex-wrap:wrap}
.chub-modelacthint{margin-right:auto;color:var(--chub-text-3);font-size:11.5px}
.chub-modellist{display:grid;grid-template-columns:1fr;gap:3px;padding-top:6px}
.chub-model{display:flex;align-items:center;gap:6px;min-width:0;padding:5px 7px;border-radius:6px;background:color-mix(in srgb,var(--chub-layer-2) 66%,transparent);font-size:12px;line-height:1.5;cursor:pointer}
.chub-model:hover{background:var(--chub-layer-2)}
.chub-model.off{opacity:.48}
.chub-model input{width:13px;height:13px;margin:0;flex:none;accent-color:var(--chub-accent)}
.chub-modelname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--chub-text-2)}
.chub-promo{flex:none;padding:0 5px;border-radius:999px;background:color-mix(in srgb,var(--chub-warn) 14%,transparent);color:color-mix(in srgb,var(--chub-warn) 80%,var(--chub-text));font-size:11px;font-weight:600;line-height:1.6;letter-spacing:0;white-space:nowrap}
.chub-factor{flex:none;padding:0 5px;border:1px solid color-mix(in srgb,var(--chan-accent) 22%,transparent);border-radius:999px;background:color-mix(in srgb,var(--chan-accent) 10%,var(--chub-layer-2));color:color-mix(in srgb,var(--chan-accent) 68%,var(--chub-text));font-size:11px;font-weight:650;line-height:1.6;font-variant-numeric:tabular-nums;letter-spacing:0;white-space:nowrap}
.chub-panel{display:flex;flex-direction:column;gap:10px;min-width:0;padding:14px 15px;border:1px solid var(--chub-line-soft);border-radius:14px;background:linear-gradient(160deg,var(--chub-layer-1),color-mix(in srgb,var(--chub-layer-1) 62%,transparent))}
.chub-panelhead{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap}
.chub-panelhead>div:first-child{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1 1 280px}
.chub-panelhead p{margin:0;font-size:12.5px;line-height:1.55;color:var(--chub-text-3)}
.chub-panelhint{font-size:12px;color:var(--chub-text-3);white-space:nowrap}
/* 6 张卡在宽屏按 3 列排满两行；auto-fit 会在 1240px 下排出 5+1 的孤行。 */
.chub-kpis{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}
.chub-kpi{display:flex;flex-direction:column;gap:1px;min-width:0;padding:12px 13px;border:1px solid var(--chub-line-soft);border-radius:12px;background:linear-gradient(165deg,var(--chub-layer-2),var(--chub-layer-1))}
.chub-kpilabel{font-size:11.5px;line-height:1.4;font-weight:650;letter-spacing:.08em;text-transform:uppercase;color:var(--chub-text-3)}
.chub-kpivalue{font-size:28px;line-height:1.2;font-weight:760;letter-spacing:-.025em;font-variant-numeric:tabular-nums;background:linear-gradient(110deg,var(--chub-text),color-mix(in srgb,var(--chub-accent) 68%,var(--chub-text)));-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;overflow-wrap:anywhere}
.chub-kpisub{font-size:12px;line-height:1.5;color:var(--chub-text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chub-notes{display:flex;align-items:center;gap:4px 12px;flex-wrap:wrap;padding:8px 11px;border:1px dashed var(--chub-line-soft);border-radius:10px;font-size:12.5px;line-height:1.5;color:var(--chub-text-3)}
.chub-notes b{font-weight:650;color:var(--chub-text-2)}
.chub-chartbody{display:flex;flex-direction:column;gap:4px;padding-top:2px}
.chub-chartsvg{display:block;width:100%;height:150px;overflow:visible}
.chub-bar{fill:color-mix(in srgb,var(--chub-accent) 68%,transparent);transition:opacity .15s ease}
.chub-bar:hover{opacity:1}
.chub-gridline{stroke:var(--chub-line-soft);stroke-width:1;stroke-dasharray:3 5}
/* 标签按柱子格数等分，每格居中 —— 与 SVG 里「柱心 = 格中点」严格对齐。 */
.chub-axis{display:grid;align-items:center;gap:0;font-size:11.5px;color:var(--chub-text-3);font-variant-numeric:tabular-nums}
.chub-axis span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center}
/* 双栏最小 430px：再窄就单列，避免 7 列表格被压到只剩横向滚动。 */
.chub-grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(430px,1fr));gap:10px;align-items:stretch}
.chub-grid2>section{display:flex;flex-direction:column}
.chub-fold{margin-top:1px;padding-top:7px;border-top:1px dashed var(--chub-line-soft)}
.chub-pre{max-height:210px;margin:5px 0 0;padding:9px 10px;overflow:auto;border-radius:9px;background:var(--chub-layer-1);font-size:12px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}
.chub-scroll{overflow:auto;border:1px solid var(--chub-line-soft);border-radius:11px;background:color-mix(in srgb,var(--chub-layer-1) 55%,transparent)}
.chub-panel>.chub-scroll{border-color:transparent;background:transparent}
.chub-scroll table{width:100%;border-collapse:collapse;font-size:13px;line-height:1.45}
.chub-scroll th{position:sticky;top:0;z-index:1;padding:7px 9px;border-bottom:1px solid var(--chub-line);background:var(--chub-layer-2);color:var(--chub-text-3);font-size:11.5px;font-weight:650;letter-spacing:.03em;text-align:left;white-space:nowrap}
.chub-scroll td{padding:6px 9px;border-top:1px solid var(--chub-line-soft);color:var(--chub-text-2);text-align:left;white-space:nowrap}
/* 「详情」列放的是可展开的 JSON：不换行会把整张表撑出容器。 */
.chub-scroll td:last-child{white-space:normal;vertical-align:top}
.chub-scroll td:last-child details{max-width:260px}
.chub-scroll td:last-child .chub-pre{max-width:260px}
.chub-scroll td:last-child summary{white-space:nowrap}
.chub-scroll tbody tr:first-child td{border-top:0}
.chub-scroll tbody tr:hover td{background:color-mix(in srgb,var(--chub-layer-2) 52%,transparent)}
.chub-scroll code{padding:1px 4px;border-radius:4px;background:var(--chub-layer-2);font-size:11.5px}
.chub-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;padding:22px 16px;border:1px dashed var(--chub-line);border-radius:11px;background:color-mix(in srgb,var(--chub-layer-1) 62%,transparent);text-align:center}
.chub-empty b{font-size:13.5px;font-weight:640}
.chub-empty p{margin:0;font-size:12.5px;line-height:1.55;color:var(--chub-text-3)}
.chub-pager{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:12.5px;color:var(--chub-text-3)}
.chub-pager>div{display:flex;align-items:center;gap:5px}
.chub-pager b{font-weight:650;color:var(--chub-text-2);font-variant-numeric:tabular-nums}
.chub-logpanel{padding:0;overflow:hidden}
.chub-migration{gap:9px}
.chub-panelacts{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
@keyframes chub-in{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
@media (hover:hover){
  .chub-channel:hover{transform:translateY(-2px);border-color:color-mix(in srgb,var(--chan-accent) 30%,var(--chub-line));box-shadow:0 12px 28px color-mix(in srgb,#000 10%,transparent)}
}
@media (max-width:820px){
  .chub-channels{grid-template-columns:1fr}
  .chub-grid2{grid-template-columns:1fr}
  .chub-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}
  .chub-hero{padding:18px 18px 16px}
}
@media (max-width:560px){
  .chub{gap:13px;padding:0 0 20px}
  .chub h2{font-size:23px}
  .chub-hero{padding:15px 14px 13px;border-radius:16px}
  .chub-pagehead{align-items:flex-start}
  .chub-pills{width:100%;margin-left:0}
  .chub-pill{flex:1;justify-content:center}
  .chub-ministats{grid-template-columns:1fr 1fr}
  .chub-kpis{grid-template-columns:1fr}
  .chub-navbar{align-items:stretch}
  .chub-tabs{width:100%}
  .chub-tabs button{flex:1;padding:6px 8px}
  .chub-navacts{width:100%;justify-content:space-between}
  .chub-field,.chub-field.grow{flex:1 1 100%}
  .chub-channel{padding:13px 13px 11px;border-radius:13px}
  .chub-panel{padding:12px 12px}
  .chub-chanstate{display:none}
}
@media (prefers-reduced-motion:reduce){
  .chub *,.chub *::before,.chub *::after{animation-duration:.001ms !important;transition-duration:.001ms !important}
}
`;
    const fmt = (n: any, d = 0) =>
      typeof n === "number"
        ? n.toLocaleString("zh-CN", { maximumFractionDigits: d })
        : "—";
    const pct = (n: any) =>
      typeof n === "number" ? fmt(n * 100, 1) + "%" : "—";
    const date = (n: any) => (n ? new Date(n).toLocaleString("zh-CN") : "—");
    const mark = (name: any) =>
      String(name ?? "")
        .replace(/[^A-Za-z0-9\u4e00-\u9fff]/g, "")
        .slice(0, 2)
        .toUpperCase() || "?";
    const accents: Record<string, string> = {
      codearts: "#c05a5a",
      buddy: "#2f7cf6",
      workbuddy: "#2fa58a",
      qoder: "#6b6ef5",
      qodercn: "#4c8fd9",
      lobsterai: "#d97757",
      trae: "#2fa58a",
      loomy: "#d35d8a",
      raccoon: "#b47a2e",
      gemini: "#4285f4",
    };
    const accentOf = (id: string) =>
      accents[id] ??
      ["#5b8def", "#2fa58a", "#d97757", "#8b6be0", "#3a9bd9", "#c05a5a"][
        [...id].reduce((n, ch) => n + ch.charCodeAt(0), 0) % 6
      ];
    const ago = (n: any) => {
      if (!n) return "未更新";
      const delta = Math.max(0, Date.now() - n);
      if (delta < 60000) return "刚刚";
      if (delta < 3600000) return Math.floor(delta / 60000) + " 分钟前";
      if (delta < 86400000) return Math.floor(delta / 3600000) + " 小时前";
      return Math.floor(delta / 86400000) + " 天前";
    };
    const expiryInfo = (n: any) => {
      if (typeof n !== "number" || !Number.isFinite(n) || n <= 0)
        return { text: "未提供", tone: "" };
      if (n <= Date.now()) return { text: "已过期", tone: "err" };
      if (n - Date.now() < 86400000) return { text: "今日到期", tone: "warn" };
      return { text: date(n), tone: "" };
    };
    function Page({ ctx }: any) {
      const [tab, setTab] = useState("channels");
      const [channels, setChannels] = useState([] as any[]);
      const [stats, setStats] = useState(null as any);
      const [logs, setLogs] = useState({ items: [], total: 0 } as any);
      const [error, setError] = useState("");
      const [health, setHealth] = useState(null as any);
      const [filter, setFilter] = useState({
        range: "today",
        provider: "",
        accountId: "",
        model: "",
        page: 1,
      });
      const [busy, setBusy] = useState(false);
      const [authorization, setAuthorization] = useState(null as any);
      const [importRows, setImportRows] = useState(null as any);
      /**
       * Loomy 短信登录表单（`{ provider, phone, code, msgid, hint, error }`）。
       *
       * 走页面内表单而不是 `window.prompt`：宿主界面运行在 Electron 渲染进程，
       * 那里的 `prompt()` **没有实现**，调用即抛异常 —— 按钮点下去没有任何反应，
       * 也没有错误提示。手机号/验证码本身不是业务判断，收集后仍交给同一套
       * `login.start`（模式 `sms`），宿主侧协议不变。
       */
      const [smsLogin, setSmsLogin] = useState(null as any);
      const sequence = useRef(0);
      const loginTimers = useRef(new Set<ReturnType<typeof setInterval>>());
      useEffect(
        () => () => {
          for (const timer of loginTimers.current) clearInterval(timer);
          loginTimers.current.clear();
          sequence.current++;
        },
        [],
      );
      const rpc = async (method: string, payload: any = {}) => {
        const result = await ctx.connection.rpc.call("/api", "channel-hub", {
          version: 1,
          method,
          payload,
        });
        if (result?.ok === false)
          throw Error(result.error?.message ?? "请求失败");
        return result.value ?? result;
      };
      const query = () => {
        const day = Date.now() + 8 * 3600000;
        const from = Math.floor(day / 86400000) * 86400000 - 8 * 3600000;
        return {
          provider: filter.provider || undefined,
          accountId: filter.accountId || undefined,
          model: filter.model || undefined,
          from: filter.range === "today" ? from : undefined,
          page: filter.page,
          limit: 30,
        };
      };
      const load = async () => {
        const current = ++sequence.current;
        try {
          const [c, s, l, health] = await Promise.all([
            rpc("channels.list"),
            rpc("usage.summary", query()),
            rpc("requests.list", query()),
            rpc("health"),
          ]);
          if (current !== sequence.current) return true;
          setChannels(c);
          setStats(s);
          setLogs(l);
          setHealth(health);
          setError("");
          return true;
        } catch (e) {
          setError(String(e));
          return false;
        }
      };
      useEffect(() => {
        let active = true;
        // 正常 10 秒一次；失败后退避到 20 / 40 / 60 秒，成功即恢复。
        // 记账故障时不该每 10 秒重打 4 个请求（每个还要等到超时）。
        let delay = 10000;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const schedule = () => {
          clearTimeout(timer);
          timer = setTimeout(tick, delay);
        };
        const tick = async () => {
          if (!active) return;
          if (document.hidden) {
            schedule();
            return;
          }
          const ok = await load();
          delay = ok ? 10000 : Math.min(60000, delay * 2);
          schedule();
        };
        const wake = () => {
          if (!active) return;
          delay = 10000;
          void tick();
        };
        void tick();
        document.addEventListener("visibilitychange", wake);
        return () => {
          active = false;
          sequence.current++;
          clearTimeout(timer);
          document.removeEventListener("visibilitychange", wake);
        };
      }, [
        filter.range,
        filter.provider,
        filter.accountId,
        filter.model,
        filter.page,
      ]);
      const action = async (method: string, payload: any = {}) => {
        setBusy(true);
        try {
          const value = await rpc(method, payload);
          await load();
          return value;
        } catch (e) {
          setError(String(e));
        } finally {
          setBusy(false);
        }
      };
      const login = async (provider: string, mode?: "wechat" | "sms") => {
        setAuthorization(null);
        setError("");
        // 同一渠道同时只保留一条登录路径：发起微信扫码时关掉短信表单，反之亦然。
        setSmsLogin(null);
        if (provider === "loomy" && mode === "sms") {
          // 打开页面内表单（见 `smsLogin` 的说明），不再用 `window.prompt`。
          setSmsLogin({ provider, phone: "", code: "", msgid: "", error: "" });
          return;
        }
        const result = await action("login.start", {
          provider,
          ...(mode ? { mode } : {}),
        });
        if (!result) {
          return;
        }
        if (result.loginUrl) setAuthorization(result);
        if (result.token) {
          let finished = false;
          const timer = setInterval(async () => {
            try {
              const s = await rpc("login.poll", { token: result.token });
              if (s.status === "pending" && s.message)
                setAuthorization((current: any) =>
                  current?.token === result.token
                    ? { ...current, message: s.message }
                    : current,
                );
              if (s.status !== "pending") {
                finished = true;
                clearInterval(timer);
                loginTimers.current.delete(timer);
                setAuthorization((current: any) =>
                  current?.token === result.token ? null : current,
                );
                if (s.error) setError(s.error);
                else if (s.status === "expired")
                  setError("授权会话已失效，请重新发起登录");
                void load();
              }
            } catch (e) {
              finished = true;
              clearInterval(timer);
              loginTimers.current.delete(timer);
              setAuthorization((current: any) =>
                current?.token === result.token ? null : current,
              );
              setError(String(e));
            }
          }, 1500);
          loginTimers.current.add(timer);
          setTimeout(() => {
            clearInterval(timer);
            loginTimers.current.delete(timer);
            if (!finished) {
              finished = true;
              setAuthorization((current: any) =>
                current?.token === result.token ? null : current,
              );
              setError(
                "授权等待超时，请重新发起登录；如网页已成功，请查看账号是否已添加",
              );
            }
          }, 600000);
        }
      };
      /**
       * 短信登录的两个动作。都只调用 `login.start`：
       * - 只带 `phone` + `mode: "sms"` → 宿主下发验证码并返回 `msgid`；
       * - 带 `phone` + `code` + `msgid` → 宿主校验并落库账号。
       *
       * 手机号格式与上游 Loomy 备用路径一致（11 位大陆号码）。在页面内先校验
       * 只是为了不白跑一次请求；宿主侧仍会再校验一次。
       */
      const updateSms = (patch: any) =>
        setSmsLogin((current: any) =>
          current ? { ...current, ...patch } : current,
        );
      const sendSmsCode = async () => {
        const form = smsLogin;
        if (!form) return;
        const phone = String(form.phone ?? "").trim();
        if (!/^1[3-9]\d{9}$/.test(phone)) {
          updateSms({ error: "请输入 11 位手机号（如 13800138000）" });
          return;
        }
        setBusy(true);
        try {
          const result = await rpc("login.start", {
            provider: form.provider,
            phone,
            mode: "sms",
          });
          if (!result?.msgid) throw Error("验证码下发失败，请重试");
          updateSms({
            phone,
            msgid: result.msgid,
            code: "",
            error: "",
            hint: "验证码已发送，请在收到后填写并提交登录。",
          });
        } catch (e) {
          updateSms({ error: String(e) });
        } finally {
          setBusy(false);
        }
      };
      const submitSmsCode = async () => {
        const form = smsLogin;
        if (!form) return;
        if (!form.msgid) {
          updateSms({ error: "请先获取验证码" });
          return;
        }
        const code = String(form.code ?? "").trim();
        if (!/^\d{4,8}$/.test(code)) {
          updateSms({ error: "请输入短信验证码" });
          return;
        }
        setBusy(true);
        try {
          await rpc("login.start", {
            provider: form.provider,
            phone: form.phone,
            code,
            msgid: form.msgid,
            mode: "sms",
          });
          setSmsLogin(null);
          await load();
        } catch (e) {
          // 验证码输错是常见情况：保留已下发的 `msgid`，让用户直接重填，
          // 不强制重新发码（宿主侧同样只在明确过期时才要求重发）。
          updateSms({ error: String(e) });
        } finally {
          setBusy(false);
        }
      };
      const table = (heads: string[], rows: any[][]) =>
        h(
          "div",
          { className: "chub-scroll" },
          h(
            "table",
            null,
            h(
              "thead",
              null,
              h("tr", null, ...heads.map((x) => h("th", { key: x }, x))),
            ),
            h(
              "tbody",
              null,
              ...rows.map((row, i) =>
                h(
                  "tr",
                  { key: i },
                  ...row.map((v, j) => h("td", { key: j }, v)),
                ),
              ),
            ),
          ),
        );
      /**
       * 运行日志表：**一行一轮**。
       *
       * 一轮 = 同一条用户消息引发的全部模型调用（`logs.items` 由宿主按
       * `turnId` 聚合好）；「步数」列给出该轮调用了几次，详情只放最后一次
       * 调用的尝试原始数据，不再逐层展开每一步。
       *
       * 「流式速度」与「整块吞吐」是两个口径，分开显示：
       * - 流式速度 = 输出 token /（首字 → 结束），只有观测到首字才有；
       * - 整块吞吐 = 输出 token /（请求开始 → 结束），含首字等待，总是可得。
       * 两者绝不合并成一个平均值。
       */
      const reqTable = (items: any[]) =>
        table(
          [
            "时间",
            "渠道 / 模型",
            "结果",
            "账号",
            "耗时",
            "步数",
            "首字",
            "流式速度",
            "整块吞吐",
            "输入 / 输出",
            "缓存读 / 写",
            "思考",
            "缓存命中率",
            "详情",
          ],
          items.map((r) => {
            const a = r.attempts?.at(-1),
              m = r.metrics,
              steps = Array.isArray(r.steps) ? r.steps : [];
            return [
              date(r.started),
              r.provider + " / " + r.model,
              h(
                "span",
                {
                  className:
                    "chub-badge " +
                    (r.outcome === "success"
                      ? "ok"
                      : r.outcome === "running" || r.outcome === "cancelled"
                        ? "warn"
                        : "err"),
                },
                r.outcome,
              ),
              a?.accountName ?? a?.accountId ?? "—",
              r.ended ? fmt(r.ended - r.started) + " ms" : "运行中",
              r.stepCount ?? 1,
              m?.avgTtftMs !== null ? fmt(m?.avgTtftMs) + " ms" : "—",
              m?.avgTps !== null ? fmt(m?.avgTps, 1) + " tok/s" : "—",
              m?.avgThroughput !== null
                ? fmt(m?.avgThroughput, 1) + " tok/s"
                : "—",
              m?.reported
                ? fmt(m.input) +
                  " / " +
                  fmt(m.output) +
                  (m.reported < m.attempts ? "（部分）" : "")
                : "—",
              (m?.cacheSamples ? fmt(m.cacheRead) : "—") +
                " / " +
                (m?.cacheWriteSamples ? fmt(m.cacheWrite) : "—"),
              m?.reasoningSamples ? fmt(m.reasoning) : "—",
              pct(m?.cacheHitRate),
              h(
                "details",
                { title: r.error ?? a?.error },
                h(
                  "summary",
                  null,
                  (r.stepCount ?? 1) + " 步 · " + (steps.length || 1) + " 次调用",
                ),
                h(
                  "pre",
                  { className: "chub-pre" },
                  JSON.stringify(r.attempts, null, 2),
                ),
              ),
            ];
          }),
        );
      const btn = (label: any, onClick: any, opts: any = {}) =>
        h(
          "button",
          {
            type: "button",
            className:
              "chub-btn" +
              (opts.kind ? " " + opts.kind : "") +
              (opts.small ? " small" : ""),
            disabled: opts.disabled ?? busy,
            title: opts.title,
            onClick,
          },
          label,
        );
      const empty = (title: string, text: string) =>
        h(
          "div",
          { className: "chub-empty" },
          h("b", null, title),
          h("p", null, text),
        );
      /**
       * 一个账号的额度读数。
       *
       * 契约：`a.credits` 由宿主算好（`src/core/credits.ts` 的 `creditReading`），
       * 这里的每一句文案都直接来自它 —— **不在这里做业务判断**：
       * - `credits === undefined`：从未查询过，给「未查询」而不是「0」；
       * - `credits.error`：本次没刷上，但如果同时有 `label`，那是上次成功的读数，
       *   两者一起显示（否则一次网络抖动就会让额度看起来没了）；
       * - `progress` 缺失：面值未知，不画进度条（不补 100%）；
       * - 逐包明细里 `active === false` 的包照常列出但置灰，并单独给出
       *   「另有 N 已失效」——服务端仍会返回那部分数字，藏起来等于丢信息。
       */
      /**
       * 包级「什么时候作废 / 什么时候重置」的文案。
       *
       * 优先 `expiresAt`（上游下发的扣费截止或到期时间，Buddy / WorkBuddy /
       * Qoder / LobsterAI / Trae 都有）；没有才回落到 `resetAt`（计量周期结束，
       * 只有 Gemini 这类窗口式额度才有意义）。两者同时存在时只显示到期 ——
       * 以 Buddy 为例 `CycleEndTime` 是「每月刷新」，把它当「快作废」会误导。
       *
       * 日期解析失败时原样显示上游字符串，不猜、不显示 Invalid Date。
       */
      const packageWhen = (pkg: any): string | undefined => {
        if (typeof pkg.expiresAt === "string" && pkg.expiresAt.length > 0) {
          const at = Date.parse(pkg.expiresAt);
          return "到期 " + (Number.isFinite(at) ? date(at) : pkg.expiresAt);
        }
        if (typeof pkg.resetAt === "string" && pkg.resetAt.length > 0)
          return "周期至 " + pkg.resetAt;
        return undefined;
      };
      const creditBlock = (a: any, c: any) => {
        const credits = a.credits;
        if (credits === undefined) {
          return h(
            "div",
            { className: "chub-credits" },
            h(
              "div",
              { className: "chub-creditline" },
              h("span", { className: "chub-creditlabel" }, "额度"),
              h(
                "span",
                { className: "muted" },
                c.canBalance === false
                  ? "该渠道不提供额度查询"
                  : "尚未查询，点击“查询额度”读取",
              ),
            ),
          );
        }
        const packages = Array.isArray(credits.packages)
          ? credits.packages
          : [];
        const progress =
          typeof credits.progress === "number" ? credits.progress : undefined;
        return h(
          "div",
          { className: "chub-credits" },
          h(
            "div",
            { className: "chub-creditline" },
            h("span", { className: "chub-creditlabel" }, "额度"),
            credits.label
              ? h(
                  "b",
                  {
                    title: [
                      credits.at ? "读数时间 " + date(credits.at) : "",
                      progress !== undefined
                        ? "剩余 " + pct(progress)
                        : "面值未知，不显示百分比",
                    ]
                      .filter(Boolean)
                      .join(" · "),
                  },
                  credits.label,
                )
              : h(
                  "span",
                  { className: "muted" },
                  credits.unknown ? "无法识别的额度响应" : "未提供读数",
                ),
            ...(credits.tags ?? []).map((tag: string, i: number) =>
              h(
                "span",
                { key: "tag" + i, className: "chub-credittag", title: tag },
                tag,
              ),
            ),
            credits.at && h("span", { className: "muted" }, ago(credits.at)),
            typeof credits.packagesCount === "number" &&
              credits.packagesCount > 1 &&
              h(
                "span",
                { className: "muted" },
                credits.packagesCount + " 个包",
              ),
            typeof credits.expiredTotal === "number" &&
              h(
                "span",
                {
                  className: "muted",
                  title: "已失效包的余额不计入合计（服务端仍会返回）",
                },
                "另有 " + fmt(credits.expiredTotal, 2) + " 已失效",
              ),
          ),
          progress !== undefined &&
            h(
              "div",
              {
                className: "chub-creditbar" + (progress < 0.2 ? " low" : ""),
                role: "progressbar",
                "aria-valuemin": 0,
                "aria-valuemax": 100,
                "aria-valuenow": Math.round(progress * 100),
                title: "剩余 " + pct(progress),
              },
              h("i", { style: { width: pct(progress) } }),
            ),
          credits.note &&
            h("p", { className: "chub-creditnote" }, credits.note),
          credits.error &&
            h(
              "p",
              { className: "chub-creditnote err", title: credits.error },
              credits.label ? "本次刷新失败：" : "",
              credits.error,
            ),
          packages.length > 0 &&
            h(
              "details",
              { className: "chub-fold" },
              h(
                "summary",
                null,
                "额度明细",
                h(
                  "span",
                  { className: "chub-summaryhint" },
                  packages.length + " 项",
                ),
              ),
              h(
                "div",
                { className: "chub-pkgs" },
                ...packages.map((pkg: any, i: number) =>
                  h(
                    "div",
                    {
                      key: "pkg" + i,
                      className: "chub-pkg" + (pkg.active ? "" : " off"),
                      title: [
                        pkg.name,
                        pkg.active ? "有效" : "已失效",
                        pkg.expiresAt
                          ? "到期 " + date(Date.parse(pkg.expiresAt))
                          : "",
                        pkg.resetAt ? "周期至 " + pkg.resetAt : "",
                        pkg.used !== undefined
                          ? "已用 " + fmt(pkg.used, 2)
                          : "",
                      ]
                        .filter(Boolean)
                        .join(" · "),
                    },
                    h(
                      "div",
                      { className: "chub-pkghead" },
                      h("span", { className: "chub-pkgname" }, pkg.name),
                      h(
                        "span",
                        { className: "chub-pkgval" },
                        pkg.active ? "" : "已失效 · ",
                        pkg.label ?? "",
                      ),
                      packageWhen(pkg) &&
                        h(
                          "span",
                          {
                            className: "chub-pkgwhen",
                            title:
                              typeof pkg.expiresAt === "string" &&
                              pkg.expiresAt.length > 0
                                ? "该包的到期时间（过期后额度不可再用）"
                                : "计量周期结束时间",
                          },
                          packageWhen(pkg),
                        ),
                    ),
                    typeof pkg.progress === "number" &&
                      h(
                        "div",
                        {
                          className:
                            "chub-creditbar" +
                            (pkg.progress < 0.2 ? " low" : ""),
                        },
                        h("i", { style: { width: pct(pkg.progress) } }),
                      ),
                  ),
                ),
              ),
            ),
        );
      };
      const pager = () =>
        h(
          "div",
          { className: "chub-pager" },
          h(
            "span",
            null,
            "第 ",
            h("b", null, filter.page),
            " 页 · 共 ",
            h("b", null, logs.total),
            " 条",
          ),
          h(
            "div",
            null,
            btn(
              "上一页",
              () => setFilter({ ...filter, page: filter.page - 1 }),
              {
                small: true,
                disabled: busy || filter.page <= 1,
              },
            ),
            btn(
              "下一页",
              () => setFilter({ ...filter, page: filter.page + 1 }),
              {
                small: true,
                disabled: busy || filter.page * 30 >= logs.total,
              },
            ),
          ),
        );
      const totals = stats?.totals;
      // 轮次 / 步数只在明细保留期内可算（`daily` 日汇总不含轮次），界面上要写明。
      const counts = stats?.counts ?? { turns: 0, steps: 0 };
      const stepsPerTurn = counts.turns ? counts.steps / counts.turns : undefined;
      const accountTotal = channels.reduce(
        (n: number, c: any) => n + (c.accounts?.length ?? 0),
        0,
      );
      const enabledTotal = channels.reduce(
        (n: number, c: any) =>
          n + (c.accounts?.filter((a: any) => a.enabled).length ?? 0),
        0,
      );
      const modelIds = new Set<string>();
      for (const c of channels)
        for (const a of c.accounts ?? [])
          for (const m of a.catalog?.models ?? []) modelIds.add(m.id);
      const failedChannels = channels.filter((c: any) => c.error).length;
      const series = stats?.series ?? [];
      const maxTokens = Math.max(
        1,
        ...series.map((d: any) =>
          typeof d.totalTokens === "number" ? d.totalTokens : 0,
        ),
      );
      return h(
        "main",
        { className: "chub" },
        h("style", null, css),
        h(
          "header",
          { className: "chub-hero" },
          h(
            "div",
            { className: "chub-pagehead" },
            h(
              "div",
              { className: "chub-headline" },
              h("span", { className: "chub-eyebrow" }, "Channel Hub · DSH"),
              h("h2", null, "渠道中心"),
              h(
                "p",
                { className: "chub-sub" },
                "统一管理渠道账号、动态模型目录与真实请求用量。账号、目录和记录均留在本机。",
              ),
            ),
            h(
              "div",
              { className: "chub-pills" },
              h(
                "span",
                {
                  className:
                    "chub-pill " +
                    (health?.failedWrites > 0 ? "err" : health ? "ok" : ""),
                },
                h("span", { className: "chub-dot" }),
                health
                  ? health.failedWrites > 0
                    ? "记录异常"
                    : "记录正常"
                  : "检查中",
              ),
              h(
                "span",
                { className: "chub-pill" },
                "渠道 ",
                channels.length || "—",
              ),
              h("span", { className: "chub-pill" }, "账号 ", accountTotal),
            ),
          ),
          h(
            "div",
            { className: "chub-ministats" },
            ...[
              [
                "渠道",
                channels.length ? String(channels.length) : "—",
                failedChannels ? failedChannels + " 个异常" : "全部正常",
              ],
              ["账号", String(accountTotal), enabledTotal + " 个启用"],
              ["动态模型", String(modelIds.size), "来自远端目录"],
              [
                "尝试",
                fmt(totals?.attempts),
                filter.range === "today" ? "今日" : "全部",
              ],
            ].map(([label, value, sub]) =>
              h(
                "div",
                { className: "chub-mini", key: label },
                h("span", null, label),
                h("b", null, value),
                h("i", null, sub),
              ),
            ),
          ),
        ),
        h(
          "div",
          { className: "chub-navbar" },
          h(
            "nav",
            { className: "chub-tabs", "aria-label": "渠道中心页面" },
            ...[
              ["channels", "渠道", channels.length],
              ["dashboard", "数据看板", 0],
              ["logs", "运行日志", logs.total],
            ].map(([id, title, count]: any) =>
              h(
                "button",
                {
                  key: id,
                  type: "button",
                  "aria-current": tab === id ? "page" : undefined,
                  onClick: () => setTab(id),
                },
                title,
                count > 0 &&
                  h("span", { className: "chub-tabcount" }, fmt(count)),
              ),
            ),
          ),
          h(
            "div",
            { className: "chub-navacts" },
            h(
              "span",
              { className: "chub-hint" },
              "每 10 秒自动刷新（失败后退避）",
            ),
            btn("刷新", load, { kind: "ghost", disabled: busy }),
          ),
        ),
        error &&
          h(
            "div",
            { className: "chub-alert err", role: "alert" },
            h("b", null, "操作未完成"),
            h("p", null, error),
          ),
        authorization &&
          h(
            "div",
            { className: "chub-alert info", role: "status" },
            h(
              "b",
              null,
              authorization.browserOpened
                ? "已调用默认浏览器打开授权页"
                : "未能自动打开浏览器",
            ),
            h(
              "p",
              null,
              authorization.browserOpened
                ? "完成登录后此页面会自动刷新。"
                : "请点击下方链接继续授权。",
              authorization.userCode && " 设备授权码：",
              authorization.userCode && h("code", null, authorization.userCode),
              authorization.userCode && "，若页面未自动填入请手动输入。",
            ),
            authorization.message && h("p", null, authorization.message),
            h(
              "a",
              {
                href: authorization.loginUrl,
                target: "_blank",
                rel: "noopener noreferrer",
              },
              "打开授权页面",
            ),
          ),
        health?.failedWrites > 0 &&
          h(
            "div",
            { className: "chub-alert err" },
            h("b", null, "本地记录写入异常 " + health.failedWrites + " 次"),
            h("p", null, health.lastError),
          ),
        tab !== "channels" &&
          h(
            "div",
            { className: "chub-filters" },
            h(
              "div",
              { className: "chub-filterhead" },
              h("b", null, "筛选"),
              h(
                "span",
                null,
                filter.range === "today" ? "今日数据" : "全部数据",
              ),
            ),
            h(
              "div",
              { className: "chub-filterrow" },
              h(
                "label",
                { className: "chub-field" },
                h("span", null, "时间范围"),
                h(
                  "select",
                  {
                    value: filter.range,
                    onChange: (e: any) =>
                      setFilter({
                        ...filter,
                        range: e.target.value,
                        page: 1,
                      }),
                  },
                  h("option", { value: "today" }, "今日"),
                  h("option", { value: "all" }, "全部"),
                ),
              ),
              h(
                "label",
                { className: "chub-field" },
                h("span", null, "渠道"),
                h(
                  "select",
                  {
                    value: filter.provider,
                    onChange: (e: any) =>
                      setFilter({
                        ...filter,
                        provider: e.target.value,
                        accountId: "",
                        page: 1,
                      }),
                  },
                  h("option", { value: "" }, "全部渠道"),
                  ...channels.map((c: any) =>
                    h("option", { key: c.id, value: c.id }, c.name),
                  ),
                ),
              ),
              h(
                "label",
                { className: "chub-field" },
                h("span", null, "账号"),
                h(
                  "select",
                  {
                    value: filter.accountId,
                    onChange: (e: any) =>
                      setFilter({
                        ...filter,
                        accountId: e.target.value,
                        page: 1,
                      }),
                  },
                  h("option", { value: "" }, "全部账号"),
                  ...channels
                    .filter(
                      (c: any) => !filter.provider || c.id === filter.provider,
                    )
                    .flatMap((c: any) =>
                      c.accounts.map((a: any) =>
                        h(
                          "option",
                          { key: a.id, value: a.id },
                          a.nickname ?? a.id,
                        ),
                      ),
                    ),
                ),
              ),
              h(
                "label",
                { className: "chub-field grow" },
                h("span", null, "模型 ID"),
                h("input", {
                  placeholder: "按模型 ID 筛选",
                  value: filter.model,
                  onChange: (e: any) =>
                    setFilter({ ...filter, model: e.target.value, page: 1 }),
                }),
              ),
            ),
          ),
        tab === "channels" &&
          h(
            "div",
            { className: "chub-body" },
            h(
              "section",
              { className: "chub-section" },
              h(
                "div",
                { className: "chub-sectionhead" },
                h(
                  "div",
                  null,
                  h("h3", null, "全部渠道"),
                  h(
                    "p",
                    { className: "chub-sectionhint" },
                    "自动签到并更新状态；额度每 5 分钟更新；每小时检查凭据，到期前 3 天续期。",
                  ),
                ),
                h(
                  "div",
                  { className: "chub-sectools" },
                  btn(
                    "旧账号导入",
                    async () =>
                      setImportRows(await action("migration.preview")),
                    { kind: "ghost", small: true },
                  ),
                ),
              ),
              importRows &&
                h(
                  "div",
                  { className: "chub-panel chub-migration" },
                  h(
                    "div",
                    { className: "chub-panelhead" },
                    h(
                      "div",
                      null,
                      h("h4", null, "旧账号迁移预览"),
                      h(
                        "p",
                        null,
                        "仅导入旧项目中的账号与模型偏好；重复导入不会覆盖现有登录。",
                      ),
                    ),
                  ),
                  table(
                    ["来源", "账号", "渠道", "状态", "隐藏模型"],
                    importRows.map((row: any) => [
                      row.source ?? "导入结果",
                      row.nickname ?? row.id,
                      row.provider ?? "—",
                      row.status ??
                        (row.imported
                          ? "已导入"
                          : row.requiresLogin
                            ? "需要重新登录"
                            : "可导入"),
                      fmt(row.hiddenModels),
                    ]),
                  ),
                  h(
                    "div",
                    { className: "chub-panelacts" },
                    btn(
                      "确认导入账号及模型偏好",
                      async () =>
                        setImportRows(
                          await action("migration.import", { confirm: true }),
                        ),
                      { kind: "primary", small: true },
                    ),
                    btn("收起", () => setImportRows(null), {
                      kind: "ghost",
                      small: true,
                    }),
                  ),
                ),
              h(
                "div",
                { className: "chub-channels" },
                ...channels.map((c: any) => {
                  const accounts = c.accounts ?? [];
                  const catalogModels = new Set<string>();
                  for (const a of accounts)
                    for (const m of a.catalog?.models ?? [])
                      catalogModels.add(m.id);
                  const latest = Math.max(
                    0,
                    ...accounts.map((a: any) => a.catalog?.updated ?? 0),
                  );
                  const stale = accounts.filter(
                    (a: any) => a.catalog?.stale,
                  ).length;
                  const state = c.error
                    ? "err"
                    : accounts.length === 0
                      ? "idle"
                      : accounts.some((a: any) => a.enabled)
                        ? "on"
                        : "off";
                  return h(
                    "article",
                    {
                      key: c.id,
                      className: "chub-channel",
                      "data-state": state,
                      style: { "--chan-accent": accentOf(c.id) } as any,
                    },
                    h(
                      "div",
                      { className: "chub-chanhead" },
                      h("span", { className: "chub-chanlogo" }, mark(c.name)),
                      h(
                        "div",
                        { className: "chub-chanid" },
                        h("b", { title: c.name }, c.name),
                        h(
                          "span",
                          null,
                          c.id,
                          " · ",
                          accounts.length,
                          " 个账号",
                        ),
                      ),
                      h(
                        "span",
                        { className: "chub-chanstate" },
                        c.error
                          ? "渠道异常"
                          : accounts.length === 0
                            ? "未接入"
                            : accounts.some((a: any) => a.enabled)
                              ? "运行中"
                              : "已停用",
                      ),
                    ),
                    c.error &&
                      h("p", { className: "chub-inline err" }, c.error),
                    h(
                      "div",
                      { className: "chub-chanmeta" },
                      h(
                        "span",
                        null,
                        "账号 ",
                        h(
                          "b",
                          null,
                          accounts.filter((a: any) => a.enabled).length +
                            "/" +
                            accounts.length,
                        ),
                      ),
                      h(
                        "span",
                        null,
                        "模型 ",
                        h(
                          "b",
                          null,
                          catalogModels.size ? String(catalogModels.size) : "—",
                        ),
                      ),
                      h(
                        "span",
                        {
                          className: stale ? "warn" : "",
                          title: latest ? date(latest) : "",
                        },
                        stale
                          ? "目录 · " + stale + " 个账号过期"
                          : latest
                            ? "目录 · " + ago(latest)
                            : "目录未更新",
                      ),
                    ),
                    h(
                      "div",
                      { className: "chub-chanacts" },
                      c.id === "loomy"
                        ? h(
                            React.Fragment,
                            null,
                            btn("微信扫码登录", () => login(c.id, "wechat"), {
                              kind: "primary",
                              small: true,
                              disabled:
                                busy || !!c.error || c.canLogin === false,
                            }),
                            btn("短信登录", () => login(c.id, "sms"), {
                              small: true,
                              disabled:
                                busy || !!c.error || c.canLogin === false,
                            }),
                          )
                        : btn("添加账号", () => login(c.id), {
                            kind: "primary",
                            small: true,
                            disabled: busy || !!c.error || c.canLogin === false,
                          }),
                      btn(
                        "更新模型",
                        () => action("models.refresh", { provider: c.id }),
                        { small: true },
                      ),
                    ),
                    smsLogin?.provider === c.id &&
                      h(
                        "div",
                        { className: "chub-smsform" },
                        h(
                          "div",
                          { className: "chub-smsfields" },
                          h(
                            "label",
                            { className: "chub-field" },
                            h("span", null, "手机号"),
                            h("input", {
                              type: "tel",
                              inputMode: "numeric",
                              autoComplete: "tel",
                              value: smsLogin.phone,
                              placeholder: "11 位手机号",
                              disabled: busy,
                              onChange: (e: any) =>
                                updateSms({ phone: e.target.value, error: "" }),
                            }),
                          ),
                          h(
                            "label",
                            { className: "chub-field" },
                            h("span", null, "短信验证码"),
                            h("input", {
                              type: "text",
                              inputMode: "numeric",
                              autoComplete: "one-time-code",
                              value: smsLogin.code,
                              placeholder: "收到后填写",
                              disabled: busy || !smsLogin.msgid,
                              onChange: (e: any) =>
                                updateSms({ code: e.target.value, error: "" }),
                            }),
                          ),
                        ),
                        smsLogin.hint &&
                          h(
                            "p",
                            { className: "chub-inline muted" },
                            smsLogin.hint,
                          ),
                        smsLogin.error &&
                          h(
                            "p",
                            { className: "chub-inline err" },
                            smsLogin.error,
                          ),
                        h(
                          "div",
                          { className: "chub-chanacts" },
                          btn("获取验证码", sendSmsCode, {
                            small: true,
                            disabled: busy,
                          }),
                          btn("提交登录", submitSmsCode, {
                            kind: "primary",
                            small: true,
                            disabled: busy || !smsLogin.msgid,
                          }),
                          btn("取消", () => setSmsLogin(null), {
                            small: true,
                            disabled: busy,
                          }),
                        ),
                      ),
                    accounts.length === 0
                      ? c.canLogin === false
                        ? empty(
                            "IDE 凭据接入",
                            "此产品使用 IDE 导出凭据，请通过“旧账号导入”接入。",
                          )
                        : empty(
                            "尚未添加账号",
                            "登录后会在此显示账号状态与动态目录。",
                          )
                      : h(
                          "div",
                          { className: "chub-acctlist" },
                          ...accounts.map((a: any) => {
                            const cat = a.catalog ?? {};
                            const models = cat.models ?? [];
                            const disabledModels = cat.disabled ?? [];
                            const allModelsOff =
                              models.length > 0 &&
                              models.every((m: any) =>
                                disabledModels.includes(m.id),
                              );
                            const exp = expiryInfo(a.expiresAt);
                            return h(
                              "section",
                              { key: a.id, className: "chub-acct" },
                              h(
                                "div",
                                { className: "chub-accthead" },
                                h(
                                  "span",
                                  { className: "chub-avatar" },
                                  mark(a.nickname || a.id),
                                ),
                                h(
                                  "div",
                                  { className: "chub-acctid" },
                                  h(
                                    "b",
                                    { title: a.nickname },
                                    a.nickname || "未命名账号",
                                  ),
                                  h(
                                    "span",
                                    null,
                                    "到期 ",
                                    h("i", { className: exp.tone }, exp.text),
                                  ),
                                ),
                                h(
                                  "div",
                                  { className: "chub-acctbadges" },
                                  h(
                                    "span",
                                    {
                                      className:
                                        "chub-badge " +
                                        (a.enabled ? "ok" : "off"),
                                    },
                                    a.enabled ? "启用" : "停用",
                                  ),
                                  a.renewal?.refreshing &&
                                    h(
                                      "span",
                                      { className: "chub-badge warn" },
                                      "续期中",
                                    ),
                                  a.renewal?.error &&
                                    h(
                                      "span",
                                      {
                                        className: "chub-badge err",
                                        title: a.renewal.error,
                                      },
                                      "续期失败",
                                    ),
                                ),
                              ),
                              a.renewal?.error &&
                                h(
                                  "p",
                                  { className: "chub-inline err" },
                                  "自动续期失败：",
                                  a.renewal.error,
                                ),
                              h(
                                "div",
                                { className: "chub-acctmeta" },
                                h(
                                  "span",
                                  null,
                                  "目录 ",
                                  cat.updated ? ago(cat.updated) : "未更新",
                                ),
                                h(
                                  "span",
                                  null,
                                  "模型 ",
                                  h("b", null, fmt(models.length)),
                                ),
                                cat.stale &&
                                  h(
                                    "span",
                                    { className: "warn" },
                                    "缓存已过期",
                                  ),
                                cat.error &&
                                  h(
                                    "span",
                                    { className: "err", title: cat.error },
                                    "目录异常",
                                  ),
                              ),
                              cat.error &&
                                h(
                                  "p",
                                  { className: "chub-inline err" },
                                  cat.error,
                                ),
                              // 额度：读数、进度与逐包明细都由宿主拼好
                              // （src/core/credits.ts）。浏览器只排版，不判断
                              // 「0 / 查不到 / 多单位」—— 那三件事在两端各写一遍
                              // 必然漂移（参考项目的 `creditsOf` 同理）。
                              creditBlock(a, c),
                              h(
                                "div",
                                {
                                  className: "chub-inline",
                                  title: a.checkin?.message,
                                },
                                h("b", null, "签到："),
                                a.checkin?.label ??
                                  (c.canClaim
                                    ? "等待自动签到"
                                    : "不支持自动签到"),
                                a.checkin?.message &&
                                  h(
                                    "span",
                                    {
                                      className:
                                        a.checkin.state === "failed"
                                          ? "err"
                                          : "muted",
                                    },
                                    " · " + a.checkin.message,
                                  ),
                                a.checkin?.at &&
                                  h(
                                    "span",
                                    { className: "muted" },
                                    " · " + date(a.checkin.at),
                                  ),
                              ),
                              h(
                                "div",
                                { className: "chub-acctacts" },
                                btn(
                                  a.enabled ? "停用" : "启用",
                                  () =>
                                    action("accounts.update", {
                                      id: a.id,
                                      enabled: !a.enabled,
                                    }),
                                  { small: true },
                                ),
                                btn(
                                  "续期",
                                  () => action("accounts.renew", { id: a.id }),
                                  { small: true },
                                ),
                                c.canBalance !== false &&
                                  btn(
                                    "查询额度",
                                    () =>
                                      action("accounts.balance", {
                                        id: a.id,
                                      }),
                                    { small: true },
                                  ),
                                c.canClaim &&
                                  ["failed", "manual"].includes(
                                    a.checkin?.state,
                                  ) &&
                                  btn(
                                    a.checkin?.state === "manual"
                                      ? "手动签到"
                                      : "重试签到",
                                    () =>
                                      action("accounts.claim", { id: a.id }),
                                    { small: true },
                                  ),
                                btn(
                                  "删除",
                                  () => {
                                    if (
                                      window.confirm(
                                        "删除账号 " + a.nickname + "？",
                                      )
                                    )
                                      void action("accounts.delete", {
                                        id: a.id,
                                      });
                                  },
                                  { small: true, kind: "danger" },
                                ),
                              ),
                              h(
                                "details",
                                { className: "chub-models" },
                                h(
                                  "summary",
                                  null,
                                  "模型 ",
                                  h("b", null, models.length),
                                  h(
                                    "span",
                                    { className: "chub-summaryhint" },
                                    (disabledModels.length
                                      ? "已隐藏 " +
                                        disabledModels.length +
                                        " · "
                                      : "") + "展开管理",
                                  ),
                                ),
                                models.length === 0
                                  ? h(
                                      "p",
                                      {
                                        className: "chub-inline muted",
                                        style: { padding: "6px 2px 0" },
                                      },
                                      "目录为空。点击“更新模型”重试，远端确认的条目会自动出现。",
                                    )
                                  : h(
                                      "div",
                                      { className: "chub-modelacts" },
                                      h(
                                        "span",
                                        { className: "chub-modelacthint" },
                                        disabledModels.length
                                          ? "已隐藏 " +
                                              disabledModels.length +
                                              " / " +
                                              models.length
                                          : "共 " +
                                              models.length +
                                              " 个，全部启用",
                                      ),
                                      btn(
                                        "全部启用",
                                        () =>
                                          action("models.setDisabled", {
                                            provider: c.id,
                                            all: true,
                                            disabled: false,
                                          }),
                                        {
                                          small: true,
                                          disabled:
                                            busy || disabledModels.length === 0,
                                          title:
                                            "启用该渠道的全部模型（含历史隐藏项）",
                                        },
                                      ),
                                      btn(
                                        "全部禁用",
                                        () =>
                                          action("models.setDisabled", {
                                            provider: c.id,
                                            models: models.map(
                                              (m: any) => m.id,
                                            ),
                                            disabled: true,
                                          }),
                                        {
                                          small: true,
                                          disabled: busy || allModelsOff,
                                          title: "禁用当前目录中的全部模型",
                                        },
                                      ),
                                    ),
                                models.length > 0 &&
                                  h(
                                    "div",
                                    { className: "chub-modellist" },
                                    ...models.map((m: any) => {
                                      const hidden = disabledModels.includes(
                                        m.id,
                                      );
                                      const rate = rateLabel(m);
                                      const note = promotionNote(m);
                                      const window = promotionWindow(m);
                                      const tip = [
                                        m.id,
                                        rate ? "计费系数 " + rate : "",
                                        note
                                          ? "活动 " +
                                            note +
                                            (window && !note.includes(window)
                                              ? "（" + window + "）"
                                              : "")
                                          : "",
                                      ]
                                        .filter(Boolean)
                                        .join(" · ");
                                      return h(
                                        "label",
                                        {
                                          key: m.id,
                                          className:
                                            "chub-model" +
                                            (hidden ? " off" : ""),
                                          title: tip,
                                        },
                                        h("input", {
                                          type: "checkbox",
                                          checked: !hidden,
                                          disabled: busy,
                                          onChange: (e: any) =>
                                            action("models.setDisabled", {
                                              provider: c.id,
                                              model: m.id,
                                              disabled: !e.target.checked,
                                            }),
                                        }),
                                        h(
                                          "span",
                                          { className: "chub-modelname" },
                                          m.name || m.id,
                                        ),
                                        note &&
                                          h(
                                            "span",
                                            {
                                              className: "chub-promo",
                                              title:
                                                "活动 " +
                                                note +
                                                (window &&
                                                !note.includes(window)
                                                  ? "（" + window + "）"
                                                  : ""),
                                            },
                                            note,
                                          ),
                                        rate &&
                                          h(
                                            "span",
                                            {
                                              className: "chub-factor",
                                              title: "计费系数 " + rate,
                                            },
                                            rate,
                                          ),
                                      );
                                    }),
                                  ),
                              ),
                            );
                          }),
                        ),
                  );
                }),
              ),
              channels.length === 0 &&
                empty(
                  "正在读取渠道",
                  "渠道列表会在插件加载完成后显示；若持续为空，请查看上方错误。",
                ),
            ),
          ),
        tab === "dashboard" &&
          h(
            "div",
            { className: "chub-body" },
            !totals
              ? empty("正在汇总用量", "数据会在首次加载后显示。")
              : h(
                  React.Fragment,
                  null,
                  h(
                    "section",
                    { className: "chub-section" },
                    h(
                      "div",
                      { className: "chub-sectionhead" },
                      h(
                        "div",
                        null,
                        h("h3", null, "用量总览"),
                        h(
                          "p",
                          { className: "chub-sectionhint" },
                          filter.range === "today"
                            ? "按本地自然日统计今日轮次与用量。"
                            : "统计全部历史；轮次/步数按明细（保留 90 天）。",
                        ),
                      ),
                      h(
                        "span",
                        { className: "chub-panelhint" },
                        "已报告 ",
                        fmt(totals.reported),
                        " / ",
                        fmt(totals.attempts),
                        " 次尝试",
                      ),
                    ),
                    h(
                      "div",
                      { className: "chub-kpis" },
                      ...[
                        [
                          "轮次 / 步数",
                          fmt(counts.turns) + " / " + fmt(counts.steps),
                          fmt(stepsPerTurn, 2) + " 步/轮 · 明细保留 90 天",
                        ],
                        [
                          "Token 总量",
                          fmt(totals.totalTokens),
                          "输入与输出合计",
                        ],
                        [
                          "流式速度",
                          fmt(totals.avgTps, 1) + " tok/s",
                          fmt(totals.speedSamples) +
                            " 样本 · 首字 " +
                            fmt(totals.avgTtftMs) +
                            " ms",
                        ],
                        [
                          "整块吞吐",
                          fmt(totals.avgThroughput, 1) + " tok/s",
                          fmt(totals.throughputSamples) +
                            " 样本 · 含首字等待",
                        ],
                        [
                          "缓存命中率",
                          pct(totals.cacheHitRate),
                          "覆盖率 " +
                            pct(totals.cacheCoverage) +
                            " · 未知不计零",
                        ],
                        [
                          "成功率",
                          pct(totals.successRate),
                          "取消 " +
                            fmt(totals.cancelled) +
                            " · 中断 " +
                            fmt(totals.interrupted),
                        ],
                      ].map(([label, value, sub]) =>
                        h(
                          "article",
                          { className: "chub-kpi", key: label },
                          h("span", { className: "chub-kpilabel" }, label),
                          h("strong", { className: "chub-kpivalue" }, value),
                          h("span", { className: "chub-kpisub" }, sub),
                        ),
                      ),
                    ),
                  ),
                  h(
                    "section",
                    { className: "chub-panel chub-chart" },
                    h(
                      "div",
                      { className: "chub-panelhead" },
                      h(
                        "div",
                        null,
                        h("h4", null, "每日 Token 消耗"),
                        h(
                          "p",
                          null,
                          "按本地自然日汇总；悬停柱形查看当天数值。",
                        ),
                      ),
                      h(
                        "span",
                        { className: "chub-panelhint" },
                        series.length + " 天",
                      ),
                    ),
                    series.length === 0
                      ? empty(
                          "暂无每日数据",
                          "产生真实请求后会在这里生成趋势。",
                        )
                      : h(
                          "div",
                          { className: "chub-chartbody" },
                          h(
                            "svg",
                            {
                              viewBox: "0 0 1000 130",
                              preserveAspectRatio: "none",
                              role: "img",
                              "aria-label": "每日 Token 消耗趋势",
                              className: "chub-chartsvg",
                            },
                            ...[0, 1, 2, 3].map((i) =>
                              h("line", {
                                key: "g" + i,
                                x1: 0,
                                x2: 1000,
                                y1: 6 + i * 30,
                                y2: 6 + i * 30,
                                className: "chub-gridline",
                              }),
                            ),
                            ...series.map((day: any, i: number) => {
                              const slot = 1000 / series.length;
                              // 天数少时柱子别铺满整格，居中并限宽。
                              const width = Math.min(
                                Math.max(1, slot - 2),
                                36,
                              );
                              const height =
                                ((day.totalTokens || 0) / maxTokens) * 108;
                              return h(
                                "rect",
                                {
                                  key: day.id,
                                  x: i * slot + (slot - width) / 2,
                                  y: 118 - height,
                                  width,
                                  height,
                                  rx: 3,
                                  className: "chub-bar",
                                },
                                h(
                                  "title",
                                  null,
                                  day.id +
                                    " · " +
                                    fmt(day.totalTokens) +
                                    " Token · " +
                                    fmt(day.requests) +
                                    " 请求",
                                ),
                              );
                            }),
                          ),
                          h(
                            "div",
                            {
                              className: "chub-axis",
                              // 每根柱子一格，标签落在自己的格子里，不再用首尾拉伸。
                              style: {
                                gridTemplateColumns:
                                  "repeat(" +
                                  series.length +
                                  ", minmax(0, 1fr))",
                              },
                            },
                            ...(() => {
                              // 抽稀：约 8 个标签；末尾「最新一天」优先保留，
                              // 与它太近的前一个让位，避免最后两个日期挤在一起。
                              const step = Math.max(
                                1,
                                Math.ceil(series.length / 8),
                              );
                              const shown = new Set<number>();
                              for (let i = 0; i < series.length; i += step)
                                shown.add(i);
                              const last = series.length - 1;
                              shown.add(last);
                              for (const i of [...shown])
                                if (i !== last && last - i < step)
                                  shown.delete(i);
                              return series.map((day: any, i: number) => {
                                const text = String(day.id);
                                return h(
                                  "span",
                                  { key: "x" + day.id },
                                  shown.has(i)
                                    ? series.length > 10
                                      ? text.slice(5)
                                      : text
                                    : "",
                                );
                              });
                            })(),
                          ),
                        ),
                    series.length > 0 &&
                      h(
                        "details",
                        { className: "chub-fold" },
                        h("summary", null, "查看每日明细"),
                        table(
                          ["日期", "Token", "请求"],
                          series.map((s: any) => [
                            s.id,
                            fmt(s.totalTokens),
                            fmt(s.requests),
                          ]),
                        ),
                      ),
                  ),
                  h(
                    "div",
                    { className: "chub-grid2" },
                    ...["accounts", "models"].map((key) => {
                      const rows = stats[key] ?? [];
                      return h(
                        "section",
                        { key, className: "chub-panel" },
                        h(
                          "div",
                          { className: "chub-panelhead" },
                          h(
                            "div",
                            null,
                            h(
                              "h4",
                              null,
                              key === "accounts" ? "账号透视" : "模型性能",
                            ),
                            h(
                              "p",
                              null,
                              key === "accounts"
                                ? "按账号汇总真实请求。"
                                : "按模型汇总速度与成功率。",
                            ),
                          ),
                          h(
                            "span",
                            { className: "chub-panelhint" },
                            rows.length + " 项",
                          ),
                        ),
                        rows.length === 0
                          ? empty(
                              "暂无数据",
                              key === "accounts"
                                ? "账号产生请求后会出现在这里。"
                                : "模型产生请求后会出现在这里。",
                            )
                          : table(
                              [
                                "名称",
                                "Token",
                                "请求",
                                "成功率",
                                "流式 tok/s",
                                "整块 tok/s",
                                "首字 ms",
                              ],
                              rows.map((s: any) => [
                                s.name ?? s.id,
                                fmt(s.totalTokens),
                                fmt(s.requests),
                                pct(s.successRate),
                                fmt(s.avgTps, 1),
                                fmt(s.avgThroughput, 1),
                                fmt(s.avgTtftMs),
                              ]),
                            ),
                      );
                    }),
                  ),
                ),
          ),
        tab === "logs" &&
          h(
            "div",
            { className: "chub-body" },
            h(
              "section",
              { className: "chub-section" },
              h(
                "div",
                { className: "chub-sectionhead" },
                h(
                  "div",
                  null,
                  h("h3", null, "运行日志"),
                  h(
                    "p",
                    { className: "chub-sectionhint" },
                    "共 ",
                    logs.total,
                    " 轮 · ",
                    logs.steps ?? 0,
                    " 步 · 明细保留 90 天，日汇总永久保留。",
                  ),
                ),
              ),
              h(
                "div",
                { className: "chub-panel chub-logpanel" },
                logs.items.length === 0
                  ? empty("没有匹配的请求", "调整筛选条件或等待新的推理请求。")
                  : reqTable(logs.items),
              ),
              pager(),
            ),
          ),
      );
    }
    return {
      name: "channel-hub",
      inject: ["slots", "connection"],
      apply(ctx: any) {
        ctx.slots.inject("settings.section", () =>
          ctx.slots.register(
            {
              name: "settings.section",
              id: "channel-hub",
              order: 35,
              label: () => "渠道中心",
            },
            (props: any) => h(Page, { ...props, ctx }),
          ),
        );
      },
    };
  },
});
