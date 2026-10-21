"use strict";
(() => {
  // src/core/rate.ts
  var pad = (value) => String(value).padStart(2, "0");
  function minutesOf(value) {
    if (typeof value !== "string") return void 0;
    const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
    if (m === null) return void 0;
    const h = Number(m[1]);
    const min = Number(m[2]);
    return h < 24 && min < 60 ? h * 60 + min : void 0;
  }
  function clockOf(value) {
    const total = minutesOf(value);
    return total === void 0 ? void 0 : pad(Math.floor(total / 60)) + ":" + pad(total % 60);
  }
  function withinValidity(promo, now) {
    const from = promo.validFrom === void 0 ? Number.NaN : Date.parse(promo.validFrom);
    const until = promo.validUntil === void 0 ? Number.NaN : Date.parse(promo.validUntil);
    if (Number.isFinite(from) && now.getTime() < from) return false;
    if (Number.isFinite(until) && now.getTime() >= until) return false;
    return true;
  }
  function dailyText(promo) {
    if (!Array.isArray(promo.daily)) return void 0;
    const parts = [];
    for (const slot of promo.daily) {
      if (typeof slot !== "object" || slot === null) continue;
      const start = clockOf(slot.start);
      const end = clockOf(slot.end);
      if (start === void 0 || end === void 0) continue;
      parts.push(start + "\u2013" + end);
    }
    return parts.length > 0 ? parts.join(" / ") : void 0;
  }
  function numberText(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
      return void 0;
    return String(Number(value.toFixed(4)));
  }
  function text(value) {
    if (typeof value !== "string") return void 0;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : void 0;
  }
  function qoderPromotion(model) {
    const raw = model.promotion;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return void 0;
    const record = raw;
    const start = text(record.windowStart);
    const end = text(record.windowEnd);
    const before = typeof record.beforePromotionPriceFactor === "number" ? record.beforePromotionPriceFactor : void 0;
    const discount = typeof record.discountFactor === "number" ? record.discountFactor : void 0;
    const label = text(record.badgeZh);
    if (start === void 0 && end === void 0 && before === void 0 && label === void 0)
      return void 0;
    return {
      start,
      end,
      before,
      discount,
      active: record.active === true,
      label,
      daily: start !== void 0 && end !== void 0 ? [{ start, end }] : void 0
    };
  }
  function buddyPromotion(model) {
    const raw = model.promotion;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return void 0;
    const record = raw;
    const daily = Array.isArray(record.daily) ? record.daily : void 0;
    const label = text(record.label);
    const rate = text(record.rate);
    const validFrom = text(record.validFrom);
    const validUntil = text(record.validUntil);
    if (daily === void 0 && label === void 0 && rate === void 0) return void 0;
    return {
      daily,
      timezone: text(record.timezone),
      label,
      rate,
      validFrom,
      validUntil
    };
  }
  function promoRateText(rate) {
    if (rate === void 0) return void 0;
    if (rate === "\u514D\u8D39") return rate;
    const numeric = Number(rate.replace(/^x/, ""));
    return Number.isFinite(numeric) && numeric === 0 ? "\u514D\u8D39" : rate;
  }
  function rateLabel(model, now = /* @__PURE__ */ new Date()) {
    if (!model) return void 0;
    const price = numberText(model.priceFactor);
    if (price !== void 0) return price + "\xD7";
    const creditsText = text(model.creditsRate);
    if (creditsText !== void 0) {
      const promo = buddyPromotion(model);
      const promoRate = promo !== void 0 && withinValidity(promo, now) ? promoRateText(promo.rate) : void 0;
      const discounted = promoRate ?? text(model.discountedCreditsRate);
      if (discounted === void 0 || discounted === creditsText) return creditsText;
      return creditsText + "\u2192" + discounted;
    }
    const credits = numberText(model.creditsRate);
    if (credits !== void 0) {
      const current = credits === "0" ? "\u514D\u8D39" : "x" + credits;
      const original = numberText(model.originalCreditsRate);
      if (original !== void 0 && Number(original) > Number(credits))
        return "x" + original + "\u2192" + current;
      return current;
    }
    const cost = numberText(model.costMultiplier);
    if (cost !== void 0) return "x" + cost;
    const effective = numberText(model.effectiveMultiplier);
    if (effective !== void 0) {
      const base = numberText(model.baseMultiplier);
      if (base !== void 0 && Number(base) > Number(effective))
        return "x" + base + "\u2192x" + effective;
      return "x" + effective;
    }
    return void 0;
  }
  function promotionNote(model, now = /* @__PURE__ */ new Date()) {
    if (!model) return void 0;
    const qoder = qoderPromotion(model);
    if (qoder !== void 0) {
      if (!withinValidity(qoder, now)) return void 0;
      if (qoder.label !== void 0) return qoder.label;
      const window2 = dailyText(qoder);
      if (window2 === void 0) return void 0;
      const discount = qoder.discount;
      return discount !== void 0 ? window2 + " " + Math.round(discount * 100) / 10 + " \u6298" : window2;
    }
    const buddy = buddyPromotion(model);
    if (buddy !== void 0) {
      if (!withinValidity(buddy, now)) return void 0;
      const label = buddy.label;
      const window2 = dailyText(buddy);
      if (label !== void 0)
        return window2 === void 0 || label.includes(window2) ? label : label + " " + window2;
      return window2 ?? promoRateText(buddy.rate);
    }
    const endsAt = model.discountEndsAtSec;
    if (typeof endsAt === "number" && Number.isFinite(endsAt) && endsAt > 0) {
      const at = new Date(endsAt * 1e3);
      if (at.getTime() <= now.getTime()) return void 0;
      const stamp = pad(at.getMonth() + 1) + "-" + pad(at.getDate()) + " " + pad(at.getHours()) + ":" + pad(at.getMinutes());
      return "\u9650\u65F6\u6298\u6263\u81F3 " + stamp;
    }
    return void 0;
  }
  function promotionWindow(model, now = /* @__PURE__ */ new Date()) {
    if (!model) return void 0;
    const qoder = qoderPromotion(model);
    if (qoder !== void 0)
      return withinValidity(qoder, now) ? dailyText(qoder) : void 0;
    const buddy = buddyPromotion(model);
    if (buddy !== void 0)
      return withinValidity(buddy, now) ? dailyText(buddy) : void 0;
    return void 0;
  }

  // src/client.ts
  window.__ModuleLoader__.load({
    id: "dsh-channel-hub",
    factory: (require2) => {
      const React = require2("react");
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
/* \u989D\u5EA6\u8BFB\u6570\uFF1A\u6570\u503C\u4E0E\u5355\u4F4D\u5728\u5BBF\u4E3B\u4FA7\u62FC\u597D\uFF08core/credits.ts\uFF09\uFF0C\u8FD9\u91CC\u53EA\u6392\u7248\u3002 */
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
.chub-models summary::before,.chub-fold summary::before{content:"\u203A";display:inline-block;color:var(--chub-text-3);font-size:16px;line-height:1;transition:transform .15s ease;transform:translateY(-1px)}
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
/* 6 \u5F20\u5361\u5728\u5BBD\u5C4F\u6309 3 \u5217\u6392\u6EE1\u4E24\u884C\uFF1Bauto-fit \u4F1A\u5728 1240px \u4E0B\u6392\u51FA 5+1 \u7684\u5B64\u884C\u3002 */
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
/* \u6807\u7B7E\u6309\u67F1\u5B50\u683C\u6570\u7B49\u5206\uFF0C\u6BCF\u683C\u5C45\u4E2D \u2014\u2014 \u4E0E SVG \u91CC\u300C\u67F1\u5FC3 = \u683C\u4E2D\u70B9\u300D\u4E25\u683C\u5BF9\u9F50\u3002 */
.chub-axis{display:grid;align-items:center;gap:0;font-size:11.5px;color:var(--chub-text-3);font-variant-numeric:tabular-nums}
.chub-axis span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center}
/* \u53CC\u680F\u6700\u5C0F 430px\uFF1A\u518D\u7A84\u5C31\u5355\u5217\uFF0C\u907F\u514D 7 \u5217\u8868\u683C\u88AB\u538B\u5230\u53EA\u5269\u6A2A\u5411\u6EDA\u52A8\u3002 */
.chub-grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(430px,1fr));gap:10px;align-items:stretch}
.chub-grid2>section{display:flex;flex-direction:column}
.chub-fold{margin-top:1px;padding-top:7px;border-top:1px dashed var(--chub-line-soft)}
.chub-pre{max-height:210px;margin:5px 0 0;padding:9px 10px;overflow:auto;border-radius:9px;background:var(--chub-layer-1);font-size:12px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}
.chub-scroll{overflow:auto;border:1px solid var(--chub-line-soft);border-radius:11px;background:color-mix(in srgb,var(--chub-layer-1) 55%,transparent)}
.chub-panel>.chub-scroll{border-color:transparent;background:transparent}
.chub-scroll table{width:100%;border-collapse:collapse;font-size:13px;line-height:1.45}
.chub-scroll th{position:sticky;top:0;z-index:1;padding:7px 9px;border-bottom:1px solid var(--chub-line);background:var(--chub-layer-2);color:var(--chub-text-3);font-size:11.5px;font-weight:650;letter-spacing:.03em;text-align:left;white-space:nowrap}
.chub-scroll td{padding:6px 9px;border-top:1px solid var(--chub-line-soft);color:var(--chub-text-2);text-align:left;white-space:nowrap}
/* \u300C\u8BE6\u60C5\u300D\u5217\u653E\u7684\u662F\u53EF\u5C55\u5F00\u7684 JSON\uFF1A\u4E0D\u6362\u884C\u4F1A\u628A\u6574\u5F20\u8868\u6491\u51FA\u5BB9\u5668\u3002 */
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
      const fmt = (n, d = 0) => typeof n === "number" ? n.toLocaleString("zh-CN", { maximumFractionDigits: d }) : "\u2014";
      const pct = (n) => typeof n === "number" ? fmt(n * 100, 1) + "%" : "\u2014";
      const date = (n) => n ? new Date(n).toLocaleString("zh-CN") : "\u2014";
      const mark = (name) => String(name ?? "").replace(/[^A-Za-z0-9\u4e00-\u9fff]/g, "").slice(0, 2).toUpperCase() || "?";
      const accents = {
        codearts: "#c05a5a",
        buddy: "#2f7cf6",
        workbuddy: "#2fa58a",
        qoder: "#6b6ef5",
        qodercn: "#4c8fd9",
        lobsterai: "#d97757",
        trae: "#2fa58a",
        loomy: "#d35d8a",
        raccoon: "#b47a2e",
        gemini: "#4285f4"
      };
      const accentOf = (id) => accents[id] ?? ["#5b8def", "#2fa58a", "#d97757", "#8b6be0", "#3a9bd9", "#c05a5a"][[...id].reduce((n, ch) => n + ch.charCodeAt(0), 0) % 6];
      const ago = (n) => {
        if (!n) return "\u672A\u66F4\u65B0";
        const delta = Math.max(0, Date.now() - n);
        if (delta < 6e4) return "\u521A\u521A";
        if (delta < 36e5) return Math.floor(delta / 6e4) + " \u5206\u949F\u524D";
        if (delta < 864e5) return Math.floor(delta / 36e5) + " \u5C0F\u65F6\u524D";
        return Math.floor(delta / 864e5) + " \u5929\u524D";
      };
      const expiryInfo = (n) => {
        if (typeof n !== "number" || !Number.isFinite(n) || n <= 0)
          return { text: "\u672A\u63D0\u4F9B", tone: "" };
        if (n <= Date.now()) return { text: "\u5DF2\u8FC7\u671F", tone: "err" };
        if (n - Date.now() < 864e5) return { text: "\u4ECA\u65E5\u5230\u671F", tone: "warn" };
        return { text: date(n), tone: "" };
      };
      function Page({ ctx }) {
        const [tab, setTab] = useState("channels");
        const [channels, setChannels] = useState([]);
        const [stats, setStats] = useState(null);
        const [logs, setLogs] = useState({ items: [], total: 0 });
        const [error, setError] = useState("");
        const [health, setHealth] = useState(null);
        const [filter, setFilter] = useState({
          range: "today",
          provider: "",
          accountId: "",
          model: "",
          page: 1
        });
        const [busy, setBusy] = useState(false);
        const [authorization, setAuthorization] = useState(null);
        const [importRows, setImportRows] = useState(null);
        const [smsLogin, setSmsLogin] = useState(null);
        const sequence = useRef(0);
        const loginTimers = useRef(/* @__PURE__ */ new Set());
        useEffect(
          () => () => {
            for (const timer of loginTimers.current) clearInterval(timer);
            loginTimers.current.clear();
            sequence.current++;
          },
          []
        );
        const rpc = async (method, payload = {}) => {
          const result = await ctx.connection.rpc.call("/api", "channel-hub", {
            version: 1,
            method,
            payload
          });
          if (result?.ok === false)
            throw Error(result.error?.message ?? "\u8BF7\u6C42\u5931\u8D25");
          return result.value ?? result;
        };
        const query = () => {
          const day = Date.now() + 8 * 36e5;
          const from = Math.floor(day / 864e5) * 864e5 - 8 * 36e5;
          return {
            provider: filter.provider || void 0,
            accountId: filter.accountId || void 0,
            model: filter.model || void 0,
            from: filter.range === "today" ? from : void 0,
            page: filter.page,
            limit: 30
          };
        };
        const load = async () => {
          const current = ++sequence.current;
          try {
            const [c, s, l, health2] = await Promise.all([
              rpc("channels.list"),
              rpc("usage.summary", query()),
              rpc("requests.list", query()),
              rpc("health")
            ]);
            if (current !== sequence.current) return true;
            setChannels(c);
            setStats(s);
            setLogs(l);
            setHealth(health2);
            setError("");
            return true;
          } catch (e) {
            setError(String(e));
            return false;
          }
        };
        useEffect(() => {
          let active = true;
          let delay = 1e4;
          let timer;
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
            delay = ok ? 1e4 : Math.min(6e4, delay * 2);
            schedule();
          };
          const wake = () => {
            if (!active) return;
            delay = 1e4;
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
          filter.page
        ]);
        const action = async (method, payload = {}) => {
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
        const login = async (provider, mode) => {
          setAuthorization(null);
          setError("");
          setSmsLogin(null);
          if (provider === "loomy" && mode === "sms") {
            setSmsLogin({ provider, phone: "", code: "", msgid: "", error: "" });
            return;
          }
          const result = await action("login.start", {
            provider,
            ...mode ? { mode } : {}
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
                  setAuthorization(
                    (current) => current?.token === result.token ? { ...current, message: s.message } : current
                  );
                if (s.status !== "pending") {
                  finished = true;
                  clearInterval(timer);
                  loginTimers.current.delete(timer);
                  setAuthorization(
                    (current) => current?.token === result.token ? null : current
                  );
                  if (s.error) setError(s.error);
                  else if (s.status === "expired")
                    setError("\u6388\u6743\u4F1A\u8BDD\u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u53D1\u8D77\u767B\u5F55");
                  void load();
                }
              } catch (e) {
                finished = true;
                clearInterval(timer);
                loginTimers.current.delete(timer);
                setAuthorization(
                  (current) => current?.token === result.token ? null : current
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
                setAuthorization(
                  (current) => current?.token === result.token ? null : current
                );
                setError(
                  "\u6388\u6743\u7B49\u5F85\u8D85\u65F6\uFF0C\u8BF7\u91CD\u65B0\u53D1\u8D77\u767B\u5F55\uFF1B\u5982\u7F51\u9875\u5DF2\u6210\u529F\uFF0C\u8BF7\u67E5\u770B\u8D26\u53F7\u662F\u5426\u5DF2\u6DFB\u52A0"
                );
              }
            }, 6e5);
          }
        };
        const updateSms = (patch) => setSmsLogin(
          (current) => current ? { ...current, ...patch } : current
        );
        const sendSmsCode = async () => {
          const form = smsLogin;
          if (!form) return;
          const phone = String(form.phone ?? "").trim();
          if (!/^1[3-9]\d{9}$/.test(phone)) {
            updateSms({ error: "\u8BF7\u8F93\u5165 11 \u4F4D\u624B\u673A\u53F7\uFF08\u5982 13800138000\uFF09" });
            return;
          }
          setBusy(true);
          try {
            const result = await rpc("login.start", {
              provider: form.provider,
              phone,
              mode: "sms"
            });
            if (!result?.msgid) throw Error("\u9A8C\u8BC1\u7801\u4E0B\u53D1\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5");
            updateSms({
              phone,
              msgid: result.msgid,
              code: "",
              error: "",
              hint: "\u9A8C\u8BC1\u7801\u5DF2\u53D1\u9001\uFF0C\u8BF7\u5728\u6536\u5230\u540E\u586B\u5199\u5E76\u63D0\u4EA4\u767B\u5F55\u3002"
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
            updateSms({ error: "\u8BF7\u5148\u83B7\u53D6\u9A8C\u8BC1\u7801" });
            return;
          }
          const code = String(form.code ?? "").trim();
          if (!/^\d{4,8}$/.test(code)) {
            updateSms({ error: "\u8BF7\u8F93\u5165\u77ED\u4FE1\u9A8C\u8BC1\u7801" });
            return;
          }
          setBusy(true);
          try {
            await rpc("login.start", {
              provider: form.provider,
              phone: form.phone,
              code,
              msgid: form.msgid,
              mode: "sms"
            });
            setSmsLogin(null);
            await load();
          } catch (e) {
            updateSms({ error: String(e) });
          } finally {
            setBusy(false);
          }
        };
        const table = (heads, rows) => h(
          "div",
          { className: "chub-scroll" },
          h(
            "table",
            null,
            h(
              "thead",
              null,
              h("tr", null, ...heads.map((x) => h("th", { key: x }, x)))
            ),
            h(
              "tbody",
              null,
              ...rows.map(
                (row, i) => h(
                  "tr",
                  { key: i },
                  ...row.map((v, j) => h("td", { key: j }, v))
                )
              )
            )
          )
        );
        const reqTable = (items) => table(
          [
            "\u65F6\u95F4",
            "\u6E20\u9053 / \u6A21\u578B",
            "\u7ED3\u679C",
            "\u8D26\u53F7",
            "\u8017\u65F6",
            "\u6B65\u6570",
            "\u9996\u5B57",
            "\u6D41\u5F0F\u901F\u5EA6",
            "\u6574\u5757\u541E\u5410",
            "\u8F93\u5165 / \u8F93\u51FA",
            "\u7F13\u5B58\u8BFB / \u5199",
            "\u601D\u8003",
            "\u7F13\u5B58\u547D\u4E2D\u7387",
            "\u8BE6\u60C5"
          ],
          items.map((r) => {
            const a = r.attempts?.at(-1), m = r.metrics, steps = Array.isArray(r.steps) ? r.steps : [];
            return [
              date(r.started),
              r.provider + " / " + r.model,
              h(
                "span",
                {
                  className: "chub-badge " + (r.outcome === "success" ? "ok" : r.outcome === "running" || r.outcome === "cancelled" ? "warn" : "err")
                },
                r.outcome
              ),
              a?.accountName ?? a?.accountId ?? "\u2014",
              r.ended ? fmt(r.ended - r.started) + " ms" : "\u8FD0\u884C\u4E2D",
              r.stepCount ?? 1,
              m?.avgTtftMs !== null ? fmt(m?.avgTtftMs) + " ms" : "\u2014",
              m?.avgTps !== null ? fmt(m?.avgTps, 1) + " tok/s" : "\u2014",
              m?.avgThroughput !== null ? fmt(m?.avgThroughput, 1) + " tok/s" : "\u2014",
              m?.reported ? fmt(m.input) + " / " + fmt(m.output) + (m.reported < m.attempts ? "\uFF08\u90E8\u5206\uFF09" : "") : "\u2014",
              (m?.cacheSamples ? fmt(m.cacheRead) : "\u2014") + " / " + (m?.cacheWriteSamples ? fmt(m.cacheWrite) : "\u2014"),
              m?.reasoningSamples ? fmt(m.reasoning) : "\u2014",
              pct(m?.cacheHitRate),
              h(
                "details",
                { title: r.error ?? a?.error },
                h(
                  "summary",
                  null,
                  (r.stepCount ?? 1) + " \u6B65 \xB7 " + (steps.length || 1) + " \u6B21\u8C03\u7528"
                ),
                h(
                  "pre",
                  { className: "chub-pre" },
                  JSON.stringify(r.attempts, null, 2)
                )
              )
            ];
          })
        );
        const btn = (label, onClick, opts = {}) => h(
          "button",
          {
            type: "button",
            className: "chub-btn" + (opts.kind ? " " + opts.kind : "") + (opts.small ? " small" : ""),
            disabled: opts.disabled ?? busy,
            title: opts.title,
            onClick
          },
          label
        );
        const empty = (title, text2) => h(
          "div",
          { className: "chub-empty" },
          h("b", null, title),
          h("p", null, text2)
        );
        const packageWhen = (pkg) => {
          if (typeof pkg.expiresAt === "string" && pkg.expiresAt.length > 0) {
            const at = Date.parse(pkg.expiresAt);
            return "\u5230\u671F " + (Number.isFinite(at) ? date(at) : pkg.expiresAt);
          }
          if (typeof pkg.resetAt === "string" && pkg.resetAt.length > 0)
            return "\u5468\u671F\u81F3 " + pkg.resetAt;
          return void 0;
        };
        const creditBlock = (a, c) => {
          const credits = a.credits;
          if (credits === void 0) {
            return h(
              "div",
              { className: "chub-credits" },
              h(
                "div",
                { className: "chub-creditline" },
                h("span", { className: "chub-creditlabel" }, "\u989D\u5EA6"),
                h(
                  "span",
                  { className: "muted" },
                  c.canBalance === false ? "\u8BE5\u6E20\u9053\u4E0D\u63D0\u4F9B\u989D\u5EA6\u67E5\u8BE2" : "\u5C1A\u672A\u67E5\u8BE2\uFF0C\u70B9\u51FB\u201C\u67E5\u8BE2\u989D\u5EA6\u201D\u8BFB\u53D6"
                )
              )
            );
          }
          const packages = Array.isArray(credits.packages) ? credits.packages : [];
          const progress = typeof credits.progress === "number" ? credits.progress : void 0;
          return h(
            "div",
            { className: "chub-credits" },
            h(
              "div",
              { className: "chub-creditline" },
              h("span", { className: "chub-creditlabel" }, "\u989D\u5EA6"),
              credits.label ? h(
                "b",
                {
                  title: [
                    credits.at ? "\u8BFB\u6570\u65F6\u95F4 " + date(credits.at) : "",
                    progress !== void 0 ? "\u5269\u4F59 " + pct(progress) : "\u9762\u503C\u672A\u77E5\uFF0C\u4E0D\u663E\u793A\u767E\u5206\u6BD4"
                  ].filter(Boolean).join(" \xB7 ")
                },
                credits.label
              ) : h(
                "span",
                { className: "muted" },
                credits.unknown ? "\u65E0\u6CD5\u8BC6\u522B\u7684\u989D\u5EA6\u54CD\u5E94" : "\u672A\u63D0\u4F9B\u8BFB\u6570"
              ),
              ...(credits.tags ?? []).map(
                (tag, i) => h(
                  "span",
                  { key: "tag" + i, className: "chub-credittag", title: tag },
                  tag
                )
              ),
              credits.at && h("span", { className: "muted" }, ago(credits.at)),
              typeof credits.packagesCount === "number" && credits.packagesCount > 1 && h(
                "span",
                { className: "muted" },
                credits.packagesCount + " \u4E2A\u5305"
              ),
              typeof credits.expiredTotal === "number" && h(
                "span",
                {
                  className: "muted",
                  title: "\u5DF2\u5931\u6548\u5305\u7684\u4F59\u989D\u4E0D\u8BA1\u5165\u5408\u8BA1\uFF08\u670D\u52A1\u7AEF\u4ECD\u4F1A\u8FD4\u56DE\uFF09"
                },
                "\u53E6\u6709 " + fmt(credits.expiredTotal, 2) + " \u5DF2\u5931\u6548"
              )
            ),
            progress !== void 0 && h(
              "div",
              {
                className: "chub-creditbar" + (progress < 0.2 ? " low" : ""),
                role: "progressbar",
                "aria-valuemin": 0,
                "aria-valuemax": 100,
                "aria-valuenow": Math.round(progress * 100),
                title: "\u5269\u4F59 " + pct(progress)
              },
              h("i", { style: { width: pct(progress) } })
            ),
            credits.note && h("p", { className: "chub-creditnote" }, credits.note),
            credits.error && h(
              "p",
              { className: "chub-creditnote err", title: credits.error },
              credits.label ? "\u672C\u6B21\u5237\u65B0\u5931\u8D25\uFF1A" : "",
              credits.error
            ),
            packages.length > 0 && h(
              "details",
              { className: "chub-fold" },
              h(
                "summary",
                null,
                "\u989D\u5EA6\u660E\u7EC6",
                h(
                  "span",
                  { className: "chub-summaryhint" },
                  packages.length + " \u9879"
                )
              ),
              h(
                "div",
                { className: "chub-pkgs" },
                ...packages.map(
                  (pkg, i) => h(
                    "div",
                    {
                      key: "pkg" + i,
                      className: "chub-pkg" + (pkg.active ? "" : " off"),
                      title: [
                        pkg.name,
                        pkg.active ? "\u6709\u6548" : "\u5DF2\u5931\u6548",
                        pkg.expiresAt ? "\u5230\u671F " + date(Date.parse(pkg.expiresAt)) : "",
                        pkg.resetAt ? "\u5468\u671F\u81F3 " + pkg.resetAt : "",
                        pkg.used !== void 0 ? "\u5DF2\u7528 " + fmt(pkg.used, 2) : ""
                      ].filter(Boolean).join(" \xB7 ")
                    },
                    h(
                      "div",
                      { className: "chub-pkghead" },
                      h("span", { className: "chub-pkgname" }, pkg.name),
                      h(
                        "span",
                        { className: "chub-pkgval" },
                        pkg.active ? "" : "\u5DF2\u5931\u6548 \xB7 ",
                        pkg.label ?? ""
                      ),
                      packageWhen(pkg) && h(
                        "span",
                        {
                          className: "chub-pkgwhen",
                          title: typeof pkg.expiresAt === "string" && pkg.expiresAt.length > 0 ? "\u8BE5\u5305\u7684\u5230\u671F\u65F6\u95F4\uFF08\u8FC7\u671F\u540E\u989D\u5EA6\u4E0D\u53EF\u518D\u7528\uFF09" : "\u8BA1\u91CF\u5468\u671F\u7ED3\u675F\u65F6\u95F4"
                        },
                        packageWhen(pkg)
                      )
                    ),
                    typeof pkg.progress === "number" && h(
                      "div",
                      {
                        className: "chub-creditbar" + (pkg.progress < 0.2 ? " low" : "")
                      },
                      h("i", { style: { width: pct(pkg.progress) } })
                    )
                  )
                )
              )
            )
          );
        };
        const pager = () => h(
          "div",
          { className: "chub-pager" },
          h(
            "span",
            null,
            "\u7B2C ",
            h("b", null, filter.page),
            " \u9875 \xB7 \u5171 ",
            h("b", null, logs.total),
            " \u6761"
          ),
          h(
            "div",
            null,
            btn(
              "\u4E0A\u4E00\u9875",
              () => setFilter({ ...filter, page: filter.page - 1 }),
              {
                small: true,
                disabled: busy || filter.page <= 1
              }
            ),
            btn(
              "\u4E0B\u4E00\u9875",
              () => setFilter({ ...filter, page: filter.page + 1 }),
              {
                small: true,
                disabled: busy || filter.page * 30 >= logs.total
              }
            )
          )
        );
        const totals = stats?.totals;
        const counts = stats?.counts ?? { turns: 0, steps: 0 };
        const stepsPerTurn = counts.turns ? counts.steps / counts.turns : void 0;
        const accountTotal = channels.reduce(
          (n, c) => n + (c.accounts?.length ?? 0),
          0
        );
        const enabledTotal = channels.reduce(
          (n, c) => n + (c.accounts?.filter((a) => a.enabled).length ?? 0),
          0
        );
        const modelIds = /* @__PURE__ */ new Set();
        for (const c of channels)
          for (const a of c.accounts ?? [])
            for (const m of a.catalog?.models ?? []) modelIds.add(m.id);
        const failedChannels = channels.filter((c) => c.error).length;
        const series = stats?.series ?? [];
        const maxTokens = Math.max(
          1,
          ...series.map(
            (d) => typeof d.totalTokens === "number" ? d.totalTokens : 0
          )
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
                h("span", { className: "chub-eyebrow" }, "Channel Hub \xB7 DSH"),
                h("h2", null, "\u6E20\u9053\u4E2D\u5FC3"),
                h(
                  "p",
                  { className: "chub-sub" },
                  "\u7EDF\u4E00\u7BA1\u7406\u6E20\u9053\u8D26\u53F7\u3001\u52A8\u6001\u6A21\u578B\u76EE\u5F55\u4E0E\u771F\u5B9E\u8BF7\u6C42\u7528\u91CF\u3002\u8D26\u53F7\u3001\u76EE\u5F55\u548C\u8BB0\u5F55\u5747\u7559\u5728\u672C\u673A\u3002"
                )
              ),
              h(
                "div",
                { className: "chub-pills" },
                h(
                  "span",
                  {
                    className: "chub-pill " + (health?.failedWrites > 0 ? "err" : health ? "ok" : "")
                  },
                  h("span", { className: "chub-dot" }),
                  health ? health.failedWrites > 0 ? "\u8BB0\u5F55\u5F02\u5E38" : "\u8BB0\u5F55\u6B63\u5E38" : "\u68C0\u67E5\u4E2D"
                ),
                h(
                  "span",
                  { className: "chub-pill" },
                  "\u6E20\u9053 ",
                  channels.length || "\u2014"
                ),
                h("span", { className: "chub-pill" }, "\u8D26\u53F7 ", accountTotal)
              )
            ),
            h(
              "div",
              { className: "chub-ministats" },
              ...[
                [
                  "\u6E20\u9053",
                  channels.length ? String(channels.length) : "\u2014",
                  failedChannels ? failedChannels + " \u4E2A\u5F02\u5E38" : "\u5168\u90E8\u6B63\u5E38"
                ],
                ["\u8D26\u53F7", String(accountTotal), enabledTotal + " \u4E2A\u542F\u7528"],
                ["\u52A8\u6001\u6A21\u578B", String(modelIds.size), "\u6765\u81EA\u8FDC\u7AEF\u76EE\u5F55"],
                [
                  "\u5C1D\u8BD5",
                  fmt(totals?.attempts),
                  filter.range === "today" ? "\u4ECA\u65E5" : "\u5168\u90E8"
                ]
              ].map(
                ([label, value, sub]) => h(
                  "div",
                  { className: "chub-mini", key: label },
                  h("span", null, label),
                  h("b", null, value),
                  h("i", null, sub)
                )
              )
            )
          ),
          h(
            "div",
            { className: "chub-navbar" },
            h(
              "nav",
              { className: "chub-tabs", "aria-label": "\u6E20\u9053\u4E2D\u5FC3\u9875\u9762" },
              ...[
                ["channels", "\u6E20\u9053", channels.length],
                ["dashboard", "\u6570\u636E\u770B\u677F", 0],
                ["logs", "\u8FD0\u884C\u65E5\u5FD7", logs.total]
              ].map(
                ([id, title, count]) => h(
                  "button",
                  {
                    key: id,
                    type: "button",
                    "aria-current": tab === id ? "page" : void 0,
                    onClick: () => setTab(id)
                  },
                  title,
                  count > 0 && h("span", { className: "chub-tabcount" }, fmt(count))
                )
              )
            ),
            h(
              "div",
              { className: "chub-navacts" },
              h(
                "span",
                { className: "chub-hint" },
                "\u6BCF 10 \u79D2\u81EA\u52A8\u5237\u65B0\uFF08\u5931\u8D25\u540E\u9000\u907F\uFF09"
              ),
              btn("\u5237\u65B0", load, { kind: "ghost", disabled: busy })
            )
          ),
          error && h(
            "div",
            { className: "chub-alert err", role: "alert" },
            h("b", null, "\u64CD\u4F5C\u672A\u5B8C\u6210"),
            h("p", null, error)
          ),
          authorization && h(
            "div",
            { className: "chub-alert info", role: "status" },
            h(
              "b",
              null,
              authorization.browserOpened ? "\u5DF2\u8C03\u7528\u9ED8\u8BA4\u6D4F\u89C8\u5668\u6253\u5F00\u6388\u6743\u9875" : "\u672A\u80FD\u81EA\u52A8\u6253\u5F00\u6D4F\u89C8\u5668"
            ),
            h(
              "p",
              null,
              authorization.browserOpened ? "\u5B8C\u6210\u767B\u5F55\u540E\u6B64\u9875\u9762\u4F1A\u81EA\u52A8\u5237\u65B0\u3002" : "\u8BF7\u70B9\u51FB\u4E0B\u65B9\u94FE\u63A5\u7EE7\u7EED\u6388\u6743\u3002",
              authorization.userCode && " \u8BBE\u5907\u6388\u6743\u7801\uFF1A",
              authorization.userCode && h("code", null, authorization.userCode),
              authorization.userCode && "\uFF0C\u82E5\u9875\u9762\u672A\u81EA\u52A8\u586B\u5165\u8BF7\u624B\u52A8\u8F93\u5165\u3002"
            ),
            authorization.message && h("p", null, authorization.message),
            h(
              "a",
              {
                href: authorization.loginUrl,
                target: "_blank",
                rel: "noopener noreferrer"
              },
              "\u6253\u5F00\u6388\u6743\u9875\u9762"
            )
          ),
          health?.failedWrites > 0 && h(
            "div",
            { className: "chub-alert err" },
            h("b", null, "\u672C\u5730\u8BB0\u5F55\u5199\u5165\u5F02\u5E38 " + health.failedWrites + " \u6B21"),
            h("p", null, health.lastError)
          ),
          tab !== "channels" && h(
            "div",
            { className: "chub-filters" },
            h(
              "div",
              { className: "chub-filterhead" },
              h("b", null, "\u7B5B\u9009"),
              h(
                "span",
                null,
                filter.range === "today" ? "\u4ECA\u65E5\u6570\u636E" : "\u5168\u90E8\u6570\u636E"
              )
            ),
            h(
              "div",
              { className: "chub-filterrow" },
              h(
                "label",
                { className: "chub-field" },
                h("span", null, "\u65F6\u95F4\u8303\u56F4"),
                h(
                  "select",
                  {
                    value: filter.range,
                    onChange: (e) => setFilter({
                      ...filter,
                      range: e.target.value,
                      page: 1
                    })
                  },
                  h("option", { value: "today" }, "\u4ECA\u65E5"),
                  h("option", { value: "all" }, "\u5168\u90E8")
                )
              ),
              h(
                "label",
                { className: "chub-field" },
                h("span", null, "\u6E20\u9053"),
                h(
                  "select",
                  {
                    value: filter.provider,
                    onChange: (e) => setFilter({
                      ...filter,
                      provider: e.target.value,
                      accountId: "",
                      page: 1
                    })
                  },
                  h("option", { value: "" }, "\u5168\u90E8\u6E20\u9053"),
                  ...channels.map(
                    (c) => h("option", { key: c.id, value: c.id }, c.name)
                  )
                )
              ),
              h(
                "label",
                { className: "chub-field" },
                h("span", null, "\u8D26\u53F7"),
                h(
                  "select",
                  {
                    value: filter.accountId,
                    onChange: (e) => setFilter({
                      ...filter,
                      accountId: e.target.value,
                      page: 1
                    })
                  },
                  h("option", { value: "" }, "\u5168\u90E8\u8D26\u53F7"),
                  ...channels.filter(
                    (c) => !filter.provider || c.id === filter.provider
                  ).flatMap(
                    (c) => c.accounts.map(
                      (a) => h(
                        "option",
                        { key: a.id, value: a.id },
                        a.nickname ?? a.id
                      )
                    )
                  )
                )
              ),
              h(
                "label",
                { className: "chub-field grow" },
                h("span", null, "\u6A21\u578B ID"),
                h("input", {
                  placeholder: "\u6309\u6A21\u578B ID \u7B5B\u9009",
                  value: filter.model,
                  onChange: (e) => setFilter({ ...filter, model: e.target.value, page: 1 })
                })
              )
            )
          ),
          tab === "channels" && h(
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
                  h("h3", null, "\u5168\u90E8\u6E20\u9053"),
                  h(
                    "p",
                    { className: "chub-sectionhint" },
                    "\u81EA\u52A8\u7B7E\u5230\u5E76\u66F4\u65B0\u72B6\u6001\uFF1B\u989D\u5EA6\u6BCF 5 \u5206\u949F\u66F4\u65B0\uFF1B\u6BCF\u5C0F\u65F6\u68C0\u67E5\u51ED\u636E\uFF0C\u5230\u671F\u524D 3 \u5929\u7EED\u671F\u3002"
                  )
                ),
                h(
                  "div",
                  { className: "chub-sectools" },
                  btn(
                    "\u65E7\u8D26\u53F7\u5BFC\u5165",
                    async () => setImportRows(await action("migration.preview")),
                    { kind: "ghost", small: true }
                  )
                )
              ),
              importRows && h(
                "div",
                { className: "chub-panel chub-migration" },
                h(
                  "div",
                  { className: "chub-panelhead" },
                  h(
                    "div",
                    null,
                    h("h4", null, "\u65E7\u8D26\u53F7\u8FC1\u79FB\u9884\u89C8"),
                    h(
                      "p",
                      null,
                      "\u4EC5\u5BFC\u5165\u65E7\u9879\u76EE\u4E2D\u7684\u8D26\u53F7\u4E0E\u6A21\u578B\u504F\u597D\uFF1B\u91CD\u590D\u5BFC\u5165\u4E0D\u4F1A\u8986\u76D6\u73B0\u6709\u767B\u5F55\u3002"
                    )
                  )
                ),
                table(
                  ["\u6765\u6E90", "\u8D26\u53F7", "\u6E20\u9053", "\u72B6\u6001", "\u9690\u85CF\u6A21\u578B"],
                  importRows.map((row) => [
                    row.source ?? "\u5BFC\u5165\u7ED3\u679C",
                    row.nickname ?? row.id,
                    row.provider ?? "\u2014",
                    row.status ?? (row.imported ? "\u5DF2\u5BFC\u5165" : row.requiresLogin ? "\u9700\u8981\u91CD\u65B0\u767B\u5F55" : "\u53EF\u5BFC\u5165"),
                    fmt(row.hiddenModels)
                  ])
                ),
                h(
                  "div",
                  { className: "chub-panelacts" },
                  btn(
                    "\u786E\u8BA4\u5BFC\u5165\u8D26\u53F7\u53CA\u6A21\u578B\u504F\u597D",
                    async () => setImportRows(
                      await action("migration.import", { confirm: true })
                    ),
                    { kind: "primary", small: true }
                  ),
                  btn("\u6536\u8D77", () => setImportRows(null), {
                    kind: "ghost",
                    small: true
                  })
                )
              ),
              h(
                "div",
                { className: "chub-channels" },
                ...channels.map((c) => {
                  const accounts = c.accounts ?? [];
                  const catalogModels = /* @__PURE__ */ new Set();
                  for (const a of accounts)
                    for (const m of a.catalog?.models ?? [])
                      catalogModels.add(m.id);
                  const latest = Math.max(
                    0,
                    ...accounts.map((a) => a.catalog?.updated ?? 0)
                  );
                  const stale = accounts.filter(
                    (a) => a.catalog?.stale
                  ).length;
                  const state = c.error ? "err" : accounts.length === 0 ? "idle" : accounts.some((a) => a.enabled) ? "on" : "off";
                  return h(
                    "article",
                    {
                      key: c.id,
                      className: "chub-channel",
                      "data-state": state,
                      style: { "--chan-accent": accentOf(c.id) }
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
                          " \xB7 ",
                          accounts.length,
                          " \u4E2A\u8D26\u53F7"
                        )
                      ),
                      h(
                        "span",
                        { className: "chub-chanstate" },
                        c.error ? "\u6E20\u9053\u5F02\u5E38" : accounts.length === 0 ? "\u672A\u63A5\u5165" : accounts.some((a) => a.enabled) ? "\u8FD0\u884C\u4E2D" : "\u5DF2\u505C\u7528"
                      )
                    ),
                    c.error && h("p", { className: "chub-inline err" }, c.error),
                    h(
                      "div",
                      { className: "chub-chanmeta" },
                      h(
                        "span",
                        null,
                        "\u8D26\u53F7 ",
                        h(
                          "b",
                          null,
                          accounts.filter((a) => a.enabled).length + "/" + accounts.length
                        )
                      ),
                      h(
                        "span",
                        null,
                        "\u6A21\u578B ",
                        h(
                          "b",
                          null,
                          catalogModels.size ? String(catalogModels.size) : "\u2014"
                        )
                      ),
                      h(
                        "span",
                        {
                          className: stale ? "warn" : "",
                          title: latest ? date(latest) : ""
                        },
                        stale ? "\u76EE\u5F55 \xB7 " + stale + " \u4E2A\u8D26\u53F7\u8FC7\u671F" : latest ? "\u76EE\u5F55 \xB7 " + ago(latest) : "\u76EE\u5F55\u672A\u66F4\u65B0"
                      )
                    ),
                    h(
                      "div",
                      { className: "chub-chanacts" },
                      c.id === "loomy" ? h(
                        React.Fragment,
                        null,
                        btn("\u5FAE\u4FE1\u626B\u7801\u767B\u5F55", () => login(c.id, "wechat"), {
                          kind: "primary",
                          small: true,
                          disabled: busy || !!c.error || c.canLogin === false
                        }),
                        btn("\u77ED\u4FE1\u767B\u5F55", () => login(c.id, "sms"), {
                          small: true,
                          disabled: busy || !!c.error || c.canLogin === false
                        })
                      ) : btn("\u6DFB\u52A0\u8D26\u53F7", () => login(c.id), {
                        kind: "primary",
                        small: true,
                        disabled: busy || !!c.error || c.canLogin === false
                      }),
                      btn(
                        "\u66F4\u65B0\u6A21\u578B",
                        () => action("models.refresh", { provider: c.id }),
                        { small: true }
                      )
                    ),
                    smsLogin?.provider === c.id && h(
                      "div",
                      { className: "chub-smsform" },
                      h(
                        "div",
                        { className: "chub-smsfields" },
                        h(
                          "label",
                          { className: "chub-field" },
                          h("span", null, "\u624B\u673A\u53F7"),
                          h("input", {
                            type: "tel",
                            inputMode: "numeric",
                            autoComplete: "tel",
                            value: smsLogin.phone,
                            placeholder: "11 \u4F4D\u624B\u673A\u53F7",
                            disabled: busy,
                            onChange: (e) => updateSms({ phone: e.target.value, error: "" })
                          })
                        ),
                        h(
                          "label",
                          { className: "chub-field" },
                          h("span", null, "\u77ED\u4FE1\u9A8C\u8BC1\u7801"),
                          h("input", {
                            type: "text",
                            inputMode: "numeric",
                            autoComplete: "one-time-code",
                            value: smsLogin.code,
                            placeholder: "\u6536\u5230\u540E\u586B\u5199",
                            disabled: busy || !smsLogin.msgid,
                            onChange: (e) => updateSms({ code: e.target.value, error: "" })
                          })
                        )
                      ),
                      smsLogin.hint && h(
                        "p",
                        { className: "chub-inline muted" },
                        smsLogin.hint
                      ),
                      smsLogin.error && h(
                        "p",
                        { className: "chub-inline err" },
                        smsLogin.error
                      ),
                      h(
                        "div",
                        { className: "chub-chanacts" },
                        btn("\u83B7\u53D6\u9A8C\u8BC1\u7801", sendSmsCode, {
                          small: true,
                          disabled: busy
                        }),
                        btn("\u63D0\u4EA4\u767B\u5F55", submitSmsCode, {
                          kind: "primary",
                          small: true,
                          disabled: busy || !smsLogin.msgid
                        }),
                        btn("\u53D6\u6D88", () => setSmsLogin(null), {
                          small: true,
                          disabled: busy
                        })
                      )
                    ),
                    accounts.length === 0 ? c.canLogin === false ? empty(
                      "IDE \u51ED\u636E\u63A5\u5165",
                      "\u6B64\u4EA7\u54C1\u4F7F\u7528 IDE \u5BFC\u51FA\u51ED\u636E\uFF0C\u8BF7\u901A\u8FC7\u201C\u65E7\u8D26\u53F7\u5BFC\u5165\u201D\u63A5\u5165\u3002"
                    ) : empty(
                      "\u5C1A\u672A\u6DFB\u52A0\u8D26\u53F7",
                      "\u767B\u5F55\u540E\u4F1A\u5728\u6B64\u663E\u793A\u8D26\u53F7\u72B6\u6001\u4E0E\u52A8\u6001\u76EE\u5F55\u3002"
                    ) : h(
                      "div",
                      { className: "chub-acctlist" },
                      ...accounts.map((a) => {
                        const cat = a.catalog ?? {};
                        const models = cat.models ?? [];
                        const disabledModels = cat.disabled ?? [];
                        const allModelsOff = models.length > 0 && models.every(
                          (m) => disabledModels.includes(m.id)
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
                              mark(a.nickname || a.id)
                            ),
                            h(
                              "div",
                              { className: "chub-acctid" },
                              h(
                                "b",
                                { title: a.nickname },
                                a.nickname || "\u672A\u547D\u540D\u8D26\u53F7"
                              ),
                              h(
                                "span",
                                null,
                                "\u5230\u671F ",
                                h("i", { className: exp.tone }, exp.text)
                              )
                            ),
                            h(
                              "div",
                              { className: "chub-acctbadges" },
                              h(
                                "span",
                                {
                                  className: "chub-badge " + (a.enabled ? "ok" : "off")
                                },
                                a.enabled ? "\u542F\u7528" : "\u505C\u7528"
                              ),
                              a.renewal?.refreshing && h(
                                "span",
                                { className: "chub-badge warn" },
                                "\u7EED\u671F\u4E2D"
                              ),
                              a.renewal?.error && h(
                                "span",
                                {
                                  className: "chub-badge err",
                                  title: a.renewal.error
                                },
                                "\u7EED\u671F\u5931\u8D25"
                              )
                            )
                          ),
                          a.renewal?.error && h(
                            "p",
                            { className: "chub-inline err" },
                            "\u81EA\u52A8\u7EED\u671F\u5931\u8D25\uFF1A",
                            a.renewal.error
                          ),
                          h(
                            "div",
                            { className: "chub-acctmeta" },
                            h(
                              "span",
                              null,
                              "\u76EE\u5F55 ",
                              cat.updated ? ago(cat.updated) : "\u672A\u66F4\u65B0"
                            ),
                            h(
                              "span",
                              null,
                              "\u6A21\u578B ",
                              h("b", null, fmt(models.length))
                            ),
                            cat.stale && h(
                              "span",
                              { className: "warn" },
                              "\u7F13\u5B58\u5DF2\u8FC7\u671F"
                            ),
                            cat.error && h(
                              "span",
                              { className: "err", title: cat.error },
                              "\u76EE\u5F55\u5F02\u5E38"
                            )
                          ),
                          cat.error && h(
                            "p",
                            { className: "chub-inline err" },
                            cat.error
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
                              title: a.checkin?.message
                            },
                            h("b", null, "\u7B7E\u5230\uFF1A"),
                            a.checkin?.label ?? (c.canClaim ? "\u7B49\u5F85\u81EA\u52A8\u7B7E\u5230" : "\u4E0D\u652F\u6301\u81EA\u52A8\u7B7E\u5230"),
                            a.checkin?.message && h(
                              "span",
                              {
                                className: a.checkin.state === "failed" ? "err" : "muted"
                              },
                              " \xB7 " + a.checkin.message
                            ),
                            a.checkin?.at && h(
                              "span",
                              { className: "muted" },
                              " \xB7 " + date(a.checkin.at)
                            )
                          ),
                          h(
                            "div",
                            { className: "chub-acctacts" },
                            btn(
                              a.enabled ? "\u505C\u7528" : "\u542F\u7528",
                              () => action("accounts.update", {
                                id: a.id,
                                enabled: !a.enabled
                              }),
                              { small: true }
                            ),
                            btn(
                              "\u7EED\u671F",
                              () => action("accounts.renew", { id: a.id }),
                              { small: true }
                            ),
                            c.canBalance !== false && btn(
                              "\u67E5\u8BE2\u989D\u5EA6",
                              () => action("accounts.balance", {
                                id: a.id
                              }),
                              { small: true }
                            ),
                            c.canClaim && ["failed", "manual"].includes(
                              a.checkin?.state
                            ) && btn(
                              a.checkin?.state === "manual" ? "\u624B\u52A8\u7B7E\u5230" : "\u91CD\u8BD5\u7B7E\u5230",
                              () => action("accounts.claim", { id: a.id }),
                              { small: true }
                            ),
                            btn(
                              "\u5220\u9664",
                              () => {
                                if (window.confirm(
                                  "\u5220\u9664\u8D26\u53F7 " + a.nickname + "\uFF1F"
                                ))
                                  void action("accounts.delete", {
                                    id: a.id
                                  });
                              },
                              { small: true, kind: "danger" }
                            )
                          ),
                          h(
                            "details",
                            { className: "chub-models" },
                            h(
                              "summary",
                              null,
                              "\u6A21\u578B ",
                              h("b", null, models.length),
                              h(
                                "span",
                                { className: "chub-summaryhint" },
                                (disabledModels.length ? "\u5DF2\u9690\u85CF " + disabledModels.length + " \xB7 " : "") + "\u5C55\u5F00\u7BA1\u7406"
                              )
                            ),
                            models.length === 0 ? h(
                              "p",
                              {
                                className: "chub-inline muted",
                                style: { padding: "6px 2px 0" }
                              },
                              "\u76EE\u5F55\u4E3A\u7A7A\u3002\u70B9\u51FB\u201C\u66F4\u65B0\u6A21\u578B\u201D\u91CD\u8BD5\uFF0C\u8FDC\u7AEF\u786E\u8BA4\u7684\u6761\u76EE\u4F1A\u81EA\u52A8\u51FA\u73B0\u3002"
                            ) : h(
                              "div",
                              { className: "chub-modelacts" },
                              h(
                                "span",
                                { className: "chub-modelacthint" },
                                disabledModels.length ? "\u5DF2\u9690\u85CF " + disabledModels.length + " / " + models.length : "\u5171 " + models.length + " \u4E2A\uFF0C\u5168\u90E8\u542F\u7528"
                              ),
                              btn(
                                "\u5168\u90E8\u542F\u7528",
                                () => action("models.setDisabled", {
                                  provider: c.id,
                                  all: true,
                                  disabled: false
                                }),
                                {
                                  small: true,
                                  disabled: busy || disabledModels.length === 0,
                                  title: "\u542F\u7528\u8BE5\u6E20\u9053\u7684\u5168\u90E8\u6A21\u578B\uFF08\u542B\u5386\u53F2\u9690\u85CF\u9879\uFF09"
                                }
                              ),
                              btn(
                                "\u5168\u90E8\u7981\u7528",
                                () => action("models.setDisabled", {
                                  provider: c.id,
                                  models: models.map(
                                    (m) => m.id
                                  ),
                                  disabled: true
                                }),
                                {
                                  small: true,
                                  disabled: busy || allModelsOff,
                                  title: "\u7981\u7528\u5F53\u524D\u76EE\u5F55\u4E2D\u7684\u5168\u90E8\u6A21\u578B"
                                }
                              )
                            ),
                            models.length > 0 && h(
                              "div",
                              { className: "chub-modellist" },
                              ...models.map((m) => {
                                const hidden = disabledModels.includes(
                                  m.id
                                );
                                const rate = rateLabel(m);
                                const note = promotionNote(m);
                                const window2 = promotionWindow(m);
                                const tip = [
                                  m.id,
                                  rate ? "\u8BA1\u8D39\u7CFB\u6570 " + rate : "",
                                  note ? "\u6D3B\u52A8 " + note + (window2 && !note.includes(window2) ? "\uFF08" + window2 + "\uFF09" : "") : ""
                                ].filter(Boolean).join(" \xB7 ");
                                return h(
                                  "label",
                                  {
                                    key: m.id,
                                    className: "chub-model" + (hidden ? " off" : ""),
                                    title: tip
                                  },
                                  h("input", {
                                    type: "checkbox",
                                    checked: !hidden,
                                    disabled: busy,
                                    onChange: (e) => action("models.setDisabled", {
                                      provider: c.id,
                                      model: m.id,
                                      disabled: !e.target.checked
                                    })
                                  }),
                                  h(
                                    "span",
                                    { className: "chub-modelname" },
                                    m.name || m.id
                                  ),
                                  note && h(
                                    "span",
                                    {
                                      className: "chub-promo",
                                      title: "\u6D3B\u52A8 " + note + (window2 && !note.includes(window2) ? "\uFF08" + window2 + "\uFF09" : "")
                                    },
                                    note
                                  ),
                                  rate && h(
                                    "span",
                                    {
                                      className: "chub-factor",
                                      title: "\u8BA1\u8D39\u7CFB\u6570 " + rate
                                    },
                                    rate
                                  )
                                );
                              })
                            )
                          )
                        );
                      })
                    )
                  );
                })
              ),
              channels.length === 0 && empty(
                "\u6B63\u5728\u8BFB\u53D6\u6E20\u9053",
                "\u6E20\u9053\u5217\u8868\u4F1A\u5728\u63D2\u4EF6\u52A0\u8F7D\u5B8C\u6210\u540E\u663E\u793A\uFF1B\u82E5\u6301\u7EED\u4E3A\u7A7A\uFF0C\u8BF7\u67E5\u770B\u4E0A\u65B9\u9519\u8BEF\u3002"
              )
            )
          ),
          tab === "dashboard" && h(
            "div",
            { className: "chub-body" },
            !totals ? empty("\u6B63\u5728\u6C47\u603B\u7528\u91CF", "\u6570\u636E\u4F1A\u5728\u9996\u6B21\u52A0\u8F7D\u540E\u663E\u793A\u3002") : h(
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
                    h("h3", null, "\u7528\u91CF\u603B\u89C8"),
                    h(
                      "p",
                      { className: "chub-sectionhint" },
                      filter.range === "today" ? "\u6309\u672C\u5730\u81EA\u7136\u65E5\u7EDF\u8BA1\u4ECA\u65E5\u8F6E\u6B21\u4E0E\u7528\u91CF\u3002" : "\u7EDF\u8BA1\u5168\u90E8\u5386\u53F2\uFF1B\u8F6E\u6B21/\u6B65\u6570\u6309\u660E\u7EC6\uFF08\u4FDD\u7559 90 \u5929\uFF09\u3002"
                    )
                  ),
                  h(
                    "span",
                    { className: "chub-panelhint" },
                    "\u5DF2\u62A5\u544A ",
                    fmt(totals.reported),
                    " / ",
                    fmt(totals.attempts),
                    " \u6B21\u5C1D\u8BD5"
                  )
                ),
                h(
                  "div",
                  { className: "chub-kpis" },
                  ...[
                    [
                      "\u8F6E\u6B21 / \u6B65\u6570",
                      fmt(counts.turns) + " / " + fmt(counts.steps),
                      fmt(stepsPerTurn, 2) + " \u6B65/\u8F6E \xB7 \u660E\u7EC6\u4FDD\u7559 90 \u5929"
                    ],
                    [
                      "Token \u603B\u91CF",
                      fmt(totals.totalTokens),
                      "\u8F93\u5165\u4E0E\u8F93\u51FA\u5408\u8BA1"
                    ],
                    [
                      "\u6D41\u5F0F\u901F\u5EA6",
                      fmt(totals.avgTps, 1) + " tok/s",
                      fmt(totals.speedSamples) + " \u6837\u672C \xB7 \u9996\u5B57 " + fmt(totals.avgTtftMs) + " ms"
                    ],
                    [
                      "\u6574\u5757\u541E\u5410",
                      fmt(totals.avgThroughput, 1) + " tok/s",
                      fmt(totals.throughputSamples) + " \u6837\u672C \xB7 \u542B\u9996\u5B57\u7B49\u5F85"
                    ],
                    [
                      "\u7F13\u5B58\u547D\u4E2D\u7387",
                      pct(totals.cacheHitRate),
                      "\u8986\u76D6\u7387 " + pct(totals.cacheCoverage) + " \xB7 \u672A\u77E5\u4E0D\u8BA1\u96F6"
                    ],
                    [
                      "\u6210\u529F\u7387",
                      pct(totals.successRate),
                      "\u53D6\u6D88 " + fmt(totals.cancelled) + " \xB7 \u4E2D\u65AD " + fmt(totals.interrupted)
                    ]
                  ].map(
                    ([label, value, sub]) => h(
                      "article",
                      { className: "chub-kpi", key: label },
                      h("span", { className: "chub-kpilabel" }, label),
                      h("strong", { className: "chub-kpivalue" }, value),
                      h("span", { className: "chub-kpisub" }, sub)
                    )
                  )
                )
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
                    h("h4", null, "\u6BCF\u65E5 Token \u6D88\u8017"),
                    h(
                      "p",
                      null,
                      "\u6309\u672C\u5730\u81EA\u7136\u65E5\u6C47\u603B\uFF1B\u60AC\u505C\u67F1\u5F62\u67E5\u770B\u5F53\u5929\u6570\u503C\u3002"
                    )
                  ),
                  h(
                    "span",
                    { className: "chub-panelhint" },
                    series.length + " \u5929"
                  )
                ),
                series.length === 0 ? empty(
                  "\u6682\u65E0\u6BCF\u65E5\u6570\u636E",
                  "\u4EA7\u751F\u771F\u5B9E\u8BF7\u6C42\u540E\u4F1A\u5728\u8FD9\u91CC\u751F\u6210\u8D8B\u52BF\u3002"
                ) : h(
                  "div",
                  { className: "chub-chartbody" },
                  h(
                    "svg",
                    {
                      viewBox: "0 0 1000 130",
                      preserveAspectRatio: "none",
                      role: "img",
                      "aria-label": "\u6BCF\u65E5 Token \u6D88\u8017\u8D8B\u52BF",
                      className: "chub-chartsvg"
                    },
                    ...[0, 1, 2, 3].map(
                      (i) => h("line", {
                        key: "g" + i,
                        x1: 0,
                        x2: 1e3,
                        y1: 6 + i * 30,
                        y2: 6 + i * 30,
                        className: "chub-gridline"
                      })
                    ),
                    ...series.map((day, i) => {
                      const slot = 1e3 / series.length;
                      const width = Math.min(
                        Math.max(1, slot - 2),
                        36
                      );
                      const height = (day.totalTokens || 0) / maxTokens * 108;
                      return h(
                        "rect",
                        {
                          key: day.id,
                          x: i * slot + (slot - width) / 2,
                          y: 118 - height,
                          width,
                          height,
                          rx: 3,
                          className: "chub-bar"
                        },
                        h(
                          "title",
                          null,
                          day.id + " \xB7 " + fmt(day.totalTokens) + " Token \xB7 " + fmt(day.requests) + " \u8BF7\u6C42"
                        )
                      );
                    })
                  ),
                  h(
                    "div",
                    {
                      className: "chub-axis",
                      // 每根柱子一格，标签落在自己的格子里，不再用首尾拉伸。
                      style: {
                        gridTemplateColumns: "repeat(" + series.length + ", minmax(0, 1fr))"
                      }
                    },
                    ...(() => {
                      const step = Math.max(
                        1,
                        Math.ceil(series.length / 8)
                      );
                      const shown = /* @__PURE__ */ new Set();
                      for (let i = 0; i < series.length; i += step)
                        shown.add(i);
                      const last = series.length - 1;
                      shown.add(last);
                      for (const i of [...shown])
                        if (i !== last && last - i < step)
                          shown.delete(i);
                      return series.map((day, i) => {
                        const text2 = String(day.id);
                        return h(
                          "span",
                          { key: "x" + day.id },
                          shown.has(i) ? series.length > 10 ? text2.slice(5) : text2 : ""
                        );
                      });
                    })()
                  )
                ),
                series.length > 0 && h(
                  "details",
                  { className: "chub-fold" },
                  h("summary", null, "\u67E5\u770B\u6BCF\u65E5\u660E\u7EC6"),
                  table(
                    ["\u65E5\u671F", "Token", "\u8BF7\u6C42"],
                    series.map((s) => [
                      s.id,
                      fmt(s.totalTokens),
                      fmt(s.requests)
                    ])
                  )
                )
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
                          key === "accounts" ? "\u8D26\u53F7\u900F\u89C6" : "\u6A21\u578B\u6027\u80FD"
                        ),
                        h(
                          "p",
                          null,
                          key === "accounts" ? "\u6309\u8D26\u53F7\u6C47\u603B\u771F\u5B9E\u8BF7\u6C42\u3002" : "\u6309\u6A21\u578B\u6C47\u603B\u901F\u5EA6\u4E0E\u6210\u529F\u7387\u3002"
                        )
                      ),
                      h(
                        "span",
                        { className: "chub-panelhint" },
                        rows.length + " \u9879"
                      )
                    ),
                    rows.length === 0 ? empty(
                      "\u6682\u65E0\u6570\u636E",
                      key === "accounts" ? "\u8D26\u53F7\u4EA7\u751F\u8BF7\u6C42\u540E\u4F1A\u51FA\u73B0\u5728\u8FD9\u91CC\u3002" : "\u6A21\u578B\u4EA7\u751F\u8BF7\u6C42\u540E\u4F1A\u51FA\u73B0\u5728\u8FD9\u91CC\u3002"
                    ) : table(
                      [
                        "\u540D\u79F0",
                        "Token",
                        "\u8BF7\u6C42",
                        "\u6210\u529F\u7387",
                        "\u6D41\u5F0F tok/s",
                        "\u6574\u5757 tok/s",
                        "\u9996\u5B57 ms"
                      ],
                      rows.map((s) => [
                        s.name ?? s.id,
                        fmt(s.totalTokens),
                        fmt(s.requests),
                        pct(s.successRate),
                        fmt(s.avgTps, 1),
                        fmt(s.avgThroughput, 1),
                        fmt(s.avgTtftMs)
                      ])
                    )
                  );
                })
              )
            )
          ),
          tab === "logs" && h(
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
                  h("h3", null, "\u8FD0\u884C\u65E5\u5FD7"),
                  h(
                    "p",
                    { className: "chub-sectionhint" },
                    "\u5171 ",
                    logs.total,
                    " \u8F6E \xB7 ",
                    logs.steps ?? 0,
                    " \u6B65 \xB7 \u660E\u7EC6\u4FDD\u7559 90 \u5929\uFF0C\u65E5\u6C47\u603B\u6C38\u4E45\u4FDD\u7559\u3002"
                  )
                )
              ),
              h(
                "div",
                { className: "chub-panel chub-logpanel" },
                logs.items.length === 0 ? empty("\u6CA1\u6709\u5339\u914D\u7684\u8BF7\u6C42", "\u8C03\u6574\u7B5B\u9009\u6761\u4EF6\u6216\u7B49\u5F85\u65B0\u7684\u63A8\u7406\u8BF7\u6C42\u3002") : reqTable(logs.items)
              ),
              pager()
            )
          )
        );
      }
      return {
        name: "channel-hub",
        inject: ["slots", "connection"],
        apply(ctx) {
          ctx.slots.inject(
            "settings.section",
            () => ctx.slots.register(
              {
                name: "settings.section",
                id: "channel-hub",
                order: 35,
                label: () => "\u6E20\u9053\u4E2D\u5FC3"
              },
              (props) => h(Page, { ...props, ctx })
            )
          );
        }
      };
    }
  });
})();
