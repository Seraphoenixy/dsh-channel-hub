"use strict";
(() => {
  // src/core/rate.ts
  var pad = (value) => String(value).padStart(2, "0");
  var DEFAULT_PROMO_TIMEZONE = "Asia/Shanghai";
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
  function minuteText(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return void 0;
    const n = Math.trunc(value);
    if (n < 0 || n > 1440) return void 0;
    if (n === 1440) return "24:00";
    return pad(Math.floor(n / 60)) + ":" + pad(n % 60);
  }
  function slotMinutes(value) {
    const fromClock = minutesOf(value);
    if (fromClock !== void 0) return fromClock;
    if (typeof value !== "number" || !Number.isFinite(value)) return void 0;
    const n = Math.trunc(value);
    return n >= 0 && n <= 1440 ? n : void 0;
  }
  function slotText(value) {
    return clockOf(value) ?? minuteText(value);
  }
  function localClock(now, timezone) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        hour: "2-digit",
        minute: "2-digit",
        weekday: "short",
        hour12: false
      }).formatToParts(now);
      const pick = (type) => parts.find((p) => p.type === type)?.value;
      const hour = Number(pick("hour"));
      const minute = Number(pick("minute"));
      if (!Number.isFinite(hour) || !Number.isFinite(minute)) return void 0;
      const weekdays = {
        Mon: 1,
        Tue: 2,
        Wed: 3,
        Thu: 4,
        Fri: 5,
        Sat: 6,
        Sun: 7
      };
      const weekday = weekdays[String(pick("weekday"))];
      if (weekday === void 0) return void 0;
      return { minutes: hour % 24 * 60 + minute, weekday };
    } catch {
      return void 0;
    }
  }
  function withinValidity(discount2, now) {
    const from = discount2.validFrom === void 0 ? Number.NaN : Date.parse(discount2.validFrom);
    const until = discount2.validUntil === void 0 ? Number.NaN : Date.parse(discount2.validUntil);
    if (Number.isFinite(from) && now.getTime() < from) return false;
    if (Number.isFinite(until) && now.getTime() >= until) return false;
    return true;
  }
  function withinDaily(discount2, now) {
    const slots = discount2.daily;
    if (!Array.isArray(slots) || slots.length === 0) return true;
    const clock = localClock(now, discount2.timezone ?? DEFAULT_PROMO_TIMEZONE);
    if (clock === void 0) return false;
    for (const slot of slots) {
      if (typeof slot !== "object" || slot === null) continue;
      const start = slotMinutes(slot.start);
      const end = slotMinutes(slot.end);
      if (start === void 0 || end === void 0 || start === end) continue;
      const days = slot.weekdays;
      const dayMatches = days === void 0 || days.length === 0 || days.includes(clock.weekday);
      if (start < end) {
        if (dayMatches && clock.minutes >= start && clock.minutes < end) return true;
        continue;
      }
      if (dayMatches && clock.minutes >= start) return true;
      const previous = clock.weekday === 1 ? 7 : clock.weekday - 1;
      const previousMatches = days === void 0 || days.length === 0 || days.includes(previous);
      if (previousMatches && clock.minutes < end) return true;
    }
    return false;
  }
  function isActive(discount2, now = /* @__PURE__ */ new Date()) {
    return withinValidity(discount2, now) && withinDaily(discount2, now);
  }
  function dailyText(discount2) {
    if (!Array.isArray(discount2.daily) || discount2.daily.length === 0) return void 0;
    const parts = [];
    for (const slot of discount2.daily) {
      if (typeof slot !== "object" || slot === null) continue;
      const start = slotText(slot.start);
      const end = slotText(slot.end);
      if (start === void 0 || end === void 0) continue;
      const startMinutes = slotMinutes(slot.start);
      const endMinutes = slotMinutes(slot.end);
      const crossesMidnight = startMinutes !== void 0 && endMinutes !== void 0 && startMinutes > endMinutes;
      parts.push(start + "\u2013" + (crossesMidnight ? "\u6B21\u65E5" : "") + end);
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
  function rateOf(value) {
    const n = numberText(value);
    if (n === void 0) return void 0;
    return Number(n) === 0 ? "\u514D\u8D39" : "x" + n;
  }
  function promoRateText(rate) {
    if (rate === void 0) return void 0;
    if (rate === "\u514D\u8D39") return rate;
    const numeric = Number(rate.replace(/^x/, ""));
    return Number.isFinite(numeric) && numeric === 0 ? "\u514D\u8D39" : rate;
  }
  function discount(before, after, rest) {
    const beforeNumber = typeof before === "number" && Number.isFinite(before) && before >= 0 ? before : void 0;
    const afterNumber = typeof after === "number" && Number.isFinite(after) && after >= 0 ? after : void 0;
    if (beforeNumber === void 0 || afterNumber === void 0) return void 0;
    if (beforeNumber <= afterNumber) return void 0;
    return { before: beforeNumber, after: afterNumber, ...rest };
  }
  function qoderDiscount(model) {
    const raw = model.promotion;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return void 0;
    const record = raw;
    const start = text(record.windowStart);
    const end = text(record.windowEnd);
    const before = typeof record.beforePromotionPriceFactor === "number" ? record.beforePromotionPriceFactor : void 0;
    const factor = typeof record.discountFactor === "number" ? record.discountFactor : void 0;
    const after = before !== void 0 && factor !== void 0 ? before * factor : void 0;
    return discount(before, after, {
      ...start !== void 0 && end !== void 0 ? { daily: [{ start, end }] } : {},
      ...text(record.badgeZh) === void 0 ? {} : { label: text(record.badgeZh) }
    });
  }
  function buddyDiscount(model) {
    const raw = model.promotion;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return void 0;
    const record = raw;
    const daily = Array.isArray(record.daily) ? record.daily : void 0;
    const label = text(record.label);
    const afterText = promoRateText(text(record.rate));
    const validFrom = text(record.validFrom);
    const validUntil = text(record.validUntil);
    if (daily === void 0 && label === void 0 && afterText === void 0) return void 0;
    return {
      ...daily === void 0 ? {} : { daily },
      ...text(record.timezone) === void 0 ? {} : { timezone: text(record.timezone) },
      ...label === void 0 ? {} : { label },
      ...afterText === void 0 ? {} : { afterText },
      ...validFrom === void 0 ? {} : { validFrom },
      ...validUntil === void 0 ? {} : { validUntil }
    };
  }
  function traeDiscount(model) {
    const raw = model.offPeak;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return void 0;
    const record = raw;
    const windows = Array.isArray(record.windows) ? record.windows : void 0;
    if (windows === void 0 || windows.length === 0) return void 0;
    const before = typeof record.beforeRate === "number" ? record.beforeRate : void 0;
    const after = typeof record.afterRate === "number" ? record.afterRate : void 0;
    const daily = [];
    for (const window2 of windows) {
      if (typeof window2 !== "object" || window2 === null) continue;
      const item = window2;
      const start = item.startMinute;
      const end = item.endMinute;
      if (typeof start !== "number" || typeof end !== "number") continue;
      const rawDays = item.weekdays;
      const weekdays = Array.isArray(rawDays) ? rawDays.filter(
        (day) => typeof day === "number" && Number.isInteger(day) && day >= 1 && day <= 7
      ) : void 0;
      daily.push({
        start,
        end,
        ...weekdays === void 0 || weekdays.length === 0 ? {} : { weekdays }
      });
    }
    if (daily.length === 0) return void 0;
    const timezone = text(record.timezone);
    return discount(before, after, {
      daily,
      ...timezone === void 0 ? {} : { timezone }
    });
  }
  function discountOf(model) {
    if (!model) return void 0;
    const trae = traeDiscount(model);
    if (trae !== void 0) return trae;
    const qoder = qoderDiscount(model);
    if (qoder !== void 0) return qoder;
    const buddy = buddyDiscount(model);
    if (buddy !== void 0) {
      const before = typeof model.creditsRate === "string" ? Number(model.creditsRate.replace(/^x/, "")) : typeof model.creditsRate === "number" ? model.creditsRate : void 0;
      const after = buddy.afterText === "\u514D\u8D39" ? 0 : buddy.afterText === void 0 ? void 0 : Number(buddy.afterText.replace(/^x/, ""));
      if (before !== void 0 && after !== void 0 && Number.isFinite(before) && Number.isFinite(after)) {
        if (before > after) return { ...buddy, before, after };
        return void 0;
      }
      return buddy;
    }
    const original = typeof model.originalCreditsRate === "number" ? model.originalCreditsRate : void 0;
    const current = typeof model.creditsRate === "number" ? model.creditsRate : void 0;
    if (original !== void 0 && current !== void 0 && original > current) {
      const endsAt = typeof model.discountEndsAtSec === "number" ? model.discountEndsAtSec : void 0;
      return {
        before: original,
        after: current,
        ...endsAt === void 0 ? {} : { validUntil: new Date(endsAt * 1e3).toISOString() }
      };
    }
    return void 0;
  }
  function rateLabel(model, now = /* @__PURE__ */ new Date()) {
    if (!model) return void 0;
    const found = discountOf(model);
    if (found !== void 0) {
      const beforeText = rateOf(found.before);
      const afterText = rateOf(found.after) ?? found.afterText;
      if (beforeText !== void 0) {
        if (afterText !== void 0 && isActive(found, now)) {
          return beforeText + "\u2192" + afterText;
        }
        return beforeText;
      }
    }
    const price = numberText(model.priceFactor);
    if (price !== void 0) return price + "\xD7";
    const creditsText = text(model.creditsRate);
    if (creditsText !== void 0) return creditsText;
    const credits = numberText(model.creditsRate);
    if (credits !== void 0) return rateOf(Number(credits));
    const effective = numberText(model.effectiveMultiplier);
    if (effective !== void 0) return "x" + effective;
    return void 0;
  }
  function promotionNote(model, now = /* @__PURE__ */ new Date()) {
    if (!model) return void 0;
    const found = discountOf(model);
    if (found === void 0) return void 0;
    const active = isActive(found, now);
    const window2 = dailyText(found);
    const label = found.label;
    if (label !== void 0) {
      if (active) return label;
      return window2 === void 0 ? void 0 : label + "\uFF08\u672A\u751F\u6548\uFF09";
    }
    if (window2 !== void 0) return active ? "\u9519\u5CF0" : "\u9519\u5CF0\uFF08\u672A\u751F\u6548\uFF09";
    const deadline = deadlineText(found, now);
    return active ? deadline === void 0 ? void 0 : "\u9650\u65F6\u6298\u6263\u81F3 " + deadline : void 0;
  }
  function deadlineText(discount2, now) {
    if (discount2.validUntil === void 0) return void 0;
    const at = new Date(discount2.validUntil);
    if (!Number.isFinite(at.getTime()) || at.getTime() <= now.getTime()) return void 0;
    return pad(at.getMonth() + 1) + "-" + pad(at.getDate()) + " " + pad(at.getHours()) + ":" + pad(at.getMinutes());
  }
  function promotionWindow(model, now = /* @__PURE__ */ new Date()) {
    if (!model) return void 0;
    const found = discountOf(model);
    if (found === void 0) return void 0;
    const window2 = dailyText(found);
    if (window2 !== void 0) return window2;
    const deadline = deadlineText(found, now);
    return deadline === void 0 ? void 0 : "\u81F3 " + deadline;
  }

  // src/core/context.ts
  function tokenText(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
      return void 0;
    const n = Math.trunc(value);
    if (n % 1e6 === 0) return n / 1e6 + "M";
    if (n % 1048576 === 0) return n / 1048576 + "M";
    if (n % 1e3 === 0) return n / 1e3 + "K";
    if (n % 1024 === 0) return n / 1024 + "K";
    return String(n);
  }
  function contextTier(model) {
    if (!model) return void 0;
    const positive = (v) => typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.trunc(v) : void 0;
    const base = positive(model.contextWindow);
    const rawMax = positive(model.maxContextWindow);
    const extended = rawMax !== void 0 && (base === void 0 || rawMax > base) ? rawMax : void 0;
    if (base === void 0 && extended === void 0) return void 0;
    return {
      ...base === void 0 ? {} : { base },
      ...extended === void 0 ? {} : { extended }
    };
  }
  function extendedTierBadge(model, extendedEnabled) {
    const tier = contextTier(model);
    if (tier?.extended === void 0) return void 0;
    const label = tokenText(tier.extended);
    if (label === void 0) return void 0;
    const base = tokenText(tier.base) ?? "\u672A\u77E5";
    return {
      label,
      active: extendedEnabled,
      title: extendedEnabled ? `\u5F53\u524D\u4F7F\u7528 ${label} \u6863\uFF08\u5E38\u89C4\u6863 ${base}\uFF09\uFF1B\u8BE5\u6863\u8BA1\u8D39\u500D\u7387\u53EF\u80FD\u9AD8\u4E8E\u5E38\u89C4\u6863` : `\u8BE5\u6A21\u578B\u652F\u6301 ${label} \u6863\uFF08\u5E38\u89C4\u6863 ${base}\uFF09\uFF0C\u5F53\u524D\u672A\u542F\u7528\uFF1B\u5F00\u542F\u540E\u8BA1\u8D39\u500D\u7387\u53EF\u80FD\u9AD8\u4E8E\u5E38\u89C4\u6863`
    };
  }

  // src/client.css
  var client_default = '.chub{\n  --chub-text:var(--dsw-alias-label-primary,var(--text-primary,inherit));\n  --chub-text-2:var(--dsw-alias-label-secondary,#6b7280);\n  --chub-text-3:var(--dsw-alias-label-tertiary,#9ca3af);\n  --chub-line:var(--dsw-alias-border-l2,rgba(128,128,128,.28));\n  --chub-line-soft:var(--dsw-alias-border-l1,rgba(128,128,128,.16));\n  --chub-layer-1:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));\n  --chub-layer-2:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.09));\n  --chub-layer-3:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.13));\n  --chub-accent:var(--dsw-alias-state-business-primary,#5785dd);\n  --chub-ok:var(--dsw-alias-state-success-primary,#2f9e6b);\n  --chub-warn:var(--dsw-alias-state-warning-primary,#d6922f);\n  --chub-err:var(--dsw-alias-state-error-primary,#d55b5b);\n  display:flex;\n  flex-direction:column;\n  gap:16px;\n  width:100%;\n  box-sizing:border-box;\n  color:var(--chub-text);\n  font-size:15px;\n  line-height:1.55;\n  /*\n   * \u94FA\u6EE1\u5BBF\u4E3B\u7684\u6574\u7A97\u4E3B\u533A\u57DF\uFF08main keyed slot\uFF09\u3002\n   *\n   * \u5E03\u5C40\u5951\u7EA6\uFF1A**\u9875\u9762\u672C\u8EAB\u4E0D\u6EDA\u52A8**\uFF0C\u53EA\u6709\u5185\u5BB9\u533A\uFF08.chub-body\uFF09\u6EDA\u52A8\u3002\n   * \u6982\u89C8\u5934\u4E0E\u9875\u7B7E\u5E38\u9A7B\u53EF\u89C1\uFF0C\u4E0E\u5BBF\u4E3B\u81EA\u5DF1\u7684\u63D2\u4EF6\u7BA1\u7406 / \u4EFB\u52A1\u7BA1\u7406\u9875\u4E00\u81F4\u3002\n   *\n   * \u26A0\uFE0F \u5FC5\u987B min-width/min-height:0\uFF1A\u5BBF\u4E3B\u4E3B\u533A\u57DF\u662F flex \u9879\uFF0C\u5C11\u8FD9\u4E24\u6761\u4F1A\u8BA9\u5185\u90E8\n   * \u8868\u683C\u628A\u6574\u4E2A\u7A97\u53E3\u6491\u51FA\u6EDA\u52A8\u6761\uFF0C\u800C\u4E0D\u662F\u5728\u81EA\u5DF1\u7684\u5BB9\u5668\u91CC\u6EDA\u3002\n   *\n   * \u26A0\uFE0F overflow:hidden \u800C\u4E0D\u662F auto\uFF1A\u5916\u5C42\u4E00\u65E6\u53EF\u6EDA\uFF0C\u5185\u5BB9\u533A\u7684 flex:1 \u9AD8\u5EA6\u5C31\u4F1A\n   * \u5931\u6548\uFF08\u5185\u5BB9\u4F1A\u628A\u5BB9\u5668\u6491\u9AD8\u3001\u6574\u9875\u4E00\u8D77\u6EDA\u8D70\uFF09\uFF0C\u9875\u7B7E\u4E0D\u518D\u56FA\u5B9A\u3002\n   */\n  min-width:0;\n  min-height:0;\n  height:100%;\n  padding:0 clamp(16px,2.4vw,40px) 0;\n  overflow:hidden;\n}\n.chub *{box-sizing:border-box}\n.chub ::selection{background:color-mix(in srgb,var(--chub-accent) 30%,transparent)}\n.chub h2,.chub h3,.chub h4,.chub p{margin:0}\n.chub h2{font-size:27px;line-height:1.2;font-weight:760;letter-spacing:-.02em}\n.chub h3{font-size:16px;line-height:1.35;font-weight:680}\n.chub h4{font-size:14.5px;line-height:1.4;font-weight:660}\n.chub a{color:var(--chub-accent);text-decoration:none}\n.chub a:hover{text-decoration:underline}\n.chub :focus-visible{outline:2px solid color-mix(in srgb,var(--chub-accent) 72%,transparent);outline-offset:2px}\n/**\n * \u6982\u89C8\u5934\uFF1A**\u7D27\u51D1\u5355\u884C**\u7ED3\u6784\u3002\n *\n * \u8BBE\u8BA1\u53D6\u5411\uFF08\u7528\u6237 2026-10-21 \u62CD\u677F\uFF09\uFF1A\u8FD9\u4E00\u6761\u662F\u5E38\u9A7B\u7684\u5BFC\u822A\u6027\u533A\u57DF\uFF0C\u4E0D\u8BE5\u5360\u6389\n * \u6574\u5C4F\u9AD8\u5EA6\u7684\u5341\u5206\u4E4B\u4E00 \u2014\u2014 \u5B83\u538B\u6241\u540E\u66F4\u597D\u770B\uFF0C\u800C\u771F\u6B63\u7684\u5185\u5BB9\u7559\u7ED9\u4E0B\u9762\u7684\u6E20\u9053\u5361\u7247\u3001\n * \u56FE\u8868\u4E0E\u65E5\u5FD7\u8868\u3002\u6545\u6807\u9898\u3001\u8BF4\u660E\u3001\u72B6\u6001\u80F6\u56CA\u3001\u56DB\u4E2A\u5C0F\u6307\u6807\u5168\u90E8\u6536\u8FDB\u7EA6 90px \u9AD8\u3002\n *\n * \u26A0\uFE0F \u53EA\u538B**\u8FD9\u4E00\u5757**\uFF0C\u4E0D\u8981\u538B\u7F29\u9875\u9762\u5176\u5B83\u90E8\u5206\uFF1A\u6B63\u6587\u6309\u771F\u5B9E\u53EF\u7528\u7A7A\u95F4\u81EA\u7136\u5C55\u5F00\u3002\n */\n.chub-hero{\n  position:relative;\n  display:flex;\n  flex-direction:column;\n  gap:9px;\n  flex:none;\n  padding:12px 16px 11px;\n  overflow:hidden;\n  border:1px solid var(--chub-line-soft);\n  border-radius:13px;\n  background:\n    radial-gradient(120% 160% at 100% 0%,color-mix(in srgb,var(--chub-accent) 14%,transparent),transparent 58%),\n    linear-gradient(165deg,var(--chub-layer-2),var(--chub-layer-1));\n  box-shadow:inset 0 1px 0 color-mix(in srgb,#fff 8%,transparent);\n}\n.chub-hero::after{\n  content:"";\n  position:absolute;\n  right:-90px;\n  top:-110px;\n  width:210px;\n  height:210px;\n  border-radius:50%;\n  border:1px solid color-mix(in srgb,var(--chub-accent) 22%,transparent);\n  pointer-events:none;\n}\n.chub-pagehead{display:flex;align-items:center;gap:14px;flex-wrap:wrap;position:relative;z-index:1}\n.chub-headline{display:flex;align-items:baseline;gap:9px;min-width:0;flex:1 1 420px;flex-wrap:wrap}\n.chub-eyebrow{font-size:11px;line-height:1.4;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--chub-accent)}\n/* \u538B\u6241\u540E\u6807\u9898\u4E0E\u8BF4\u660E\u540C\u6392\uFF1A\u8BF4\u660E\u53EA\u4FDD\u7559\u4E00\u53E5\uFF0C\u8D85\u51FA\u5BBD\u5EA6\u7701\u7565\u800C\u4E0D\u662F\u6362\u884C\u6491\u9AD8\u3002 */\n.chub-headline h2{font-size:19px;line-height:1.25}\n.chub-sub{\n  margin:0;\n  min-width:0;\n  flex:1 1 260px;\n  font-size:12.5px;\n  line-height:1.45;\n  color:var(--chub-text-2);\n  overflow:hidden;\n  text-overflow:ellipsis;\n  white-space:nowrap;\n}\n.chub-pills{display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-left:auto}\n.chub-pill{\n  display:inline-flex;\n  align-items:center;\n  gap:5px;\n  padding:2px 8px;\n  border:1px solid var(--chub-line-soft);\n  border-radius:999px;\n  background:color-mix(in srgb,var(--chub-layer-2) 78%,transparent);\n  color:var(--chub-text-2);\n  font-size:11.5px;\n  line-height:1.5;\n  font-weight:560;\n  white-space:nowrap;\n}\n.chub-dot{width:5px;height:5px;border-radius:50%;background:var(--chub-text-3);flex:none}\n.chub-pill.ok{color:var(--chub-ok);border-color:color-mix(in srgb,var(--chub-ok) 28%,transparent);background:color-mix(in srgb,var(--chub-ok) 8%,transparent)}\n.chub-pill.ok .chub-dot{background:var(--chub-ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--chub-ok) 14%,transparent)}\n.chub-pill.err{color:var(--chub-err);border-color:color-mix(in srgb,var(--chub-err) 30%,transparent);background:color-mix(in srgb,var(--chub-err) 8%,transparent)}\n.chub-pill.err .chub-dot{background:var(--chub-err)}\n/**\n * \u56DB\u4E2A\u5C0F\u6307\u6807\u538B\u6210\u4E00\u6761\u7A84\u5E26\u3002\n *\n * \u26A0\uFE0F auto-fit \u800C\u4E0D\u662F\u56FA\u5B9A 4 \u5217\uFF1A\u7A84\u7A97\u53E3\u4E0B\u81EA\u52A8\u6298\u884C\uFF0C\u4E0D\u4F1A\u628A\u6570\u5B57\u6324\u6210\u4E24\u884C\u3002\n * \u6570\u503C\u7528 tabular-nums \u4FDD\u8BC1\u6296\u52A8\u65F6\u5BBD\u5EA6\u7A33\u5B9A\u3002\n */\n.chub-ministats{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:6px;position:relative;z-index:1}\n.chub-mini{display:flex;align-items:baseline;gap:6px;min-width:0;padding:4px 9px;border:1px solid var(--chub-line-soft);border-radius:9px;background:color-mix(in srgb,var(--chub-layer-1) 76%,transparent)}\n.chub-mini span{flex:none;font-size:10.5px;line-height:1.4;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--chub-text-3)}\n.chub-mini b{flex:none;font-size:15px;line-height:1.3;font-weight:700;letter-spacing:-.01em;font-variant-numeric:tabular-nums}\n.chub-mini i{flex:1 1 auto;min-width:0;font-style:normal;font-size:11px;line-height:1.4;color:var(--chub-text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.chub-navbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:none}\n.chub-tabs{display:inline-flex;align-items:center;gap:2px;padding:3px;border:1px solid var(--chub-line-soft);border-radius:10px;background:var(--chub-layer-1)}\n.chub-tabs button{\n  display:inline-flex;\n  align-items:center;\n  justify-content:center;\n  gap:6px;\n  border:0;\n  border-radius:7px;\n  padding:5px 11px;\n  background:transparent;\n  color:var(--chub-text-2);\n  font:inherit;\n  font-size:13px;\n  font-weight:600;\n  line-height:1.5;\n  cursor:pointer;\n  transition:background .16s ease,color .16s ease,box-shadow .16s ease;\n  white-space:nowrap;\n}\n.chub-tabs button:hover{background:color-mix(in srgb,var(--chub-layer-2) 82%,transparent);color:var(--chub-text)}\n.chub-tabs button[aria-current=page]{background:var(--chub-layer-3);color:var(--chub-text);box-shadow:inset 0 1px 0 color-mix(in srgb,#fff 10%,transparent),0 1px 2px rgba(0,0,0,.08)}\n.chub-tabcount{font-style:normal;font-size:11px;line-height:1;padding:2px 5px;border-radius:999px;background:color-mix(in srgb,var(--chub-accent) 14%,transparent);color:var(--chub-accent);font-variant-numeric:tabular-nums}\n.chub-navacts{display:flex;align-items:center;gap:8px;margin-left:auto}\n.chub-hint{font-size:12px;color:var(--chub-text-3);white-space:nowrap}\n.chub-btn{\n  display:inline-flex;\n  align-items:center;\n  justify-content:center;\n  gap:5px;\n  border:1px solid var(--chub-line);\n  border-radius:9px;\n  padding:6px 11px;\n  background:var(--chub-layer-2);\n  color:var(--chub-text);\n  font:inherit;\n  font-size:14px;\n  font-weight:560;\n  line-height:1.5;\n  cursor:pointer;\n  white-space:nowrap;\n  transition:background .16s ease,border-color .16s ease,color .16s ease,transform .16s ease;\n}\n.chub-btn:hover:not(:disabled){background:var(--chub-layer-3);border-color:color-mix(in srgb,var(--chub-accent) 38%,var(--chub-line))}\n.chub-btn:active:not(:disabled){transform:translateY(1px)}\n.chub-btn.primary{border-color:color-mix(in srgb,var(--chub-accent) 36%,var(--chub-line));background:color-mix(in srgb,var(--chub-accent) 13%,var(--chub-layer-1));color:var(--chub-accent)}\n.chub-btn.primary:hover:not(:disabled){background:color-mix(in srgb,var(--chub-accent) 20%,var(--chub-layer-1))}\n.chub-btn.ghost{border-color:transparent;background:transparent;color:var(--chub-text-2)}\n.chub-btn.ghost:hover:not(:disabled){border-color:var(--chub-line-soft);background:var(--chub-layer-1);color:var(--chub-text)}\n.chub-btn.danger{color:var(--chub-err)}\n.chub-btn.danger:hover:not(:disabled){border-color:color-mix(in srgb,var(--chub-err) 36%,var(--chub-line));background:color-mix(in srgb,var(--chub-err) 10%,transparent)}\n.chub-btn.small{padding:3px 8px;border-radius:7px;font-size:12.5px;font-weight:560}\n.chub-btn:disabled{opacity:.42;cursor:not-allowed}\n.chub-alert{display:flex;flex-direction:column;gap:3px;padding:10px 13px;border:1px solid var(--chub-line);border-radius:12px;background:var(--chub-layer-1)}\n.chub-alert b{font-size:14px;line-height:1.5;font-weight:650}\n.chub-alert p{margin:0;font-size:13.5px;line-height:1.65;color:var(--chub-text-2);overflow-wrap:anywhere}\n.chub-alert a{font-size:13.5px;font-weight:600;align-self:flex-start}\n.chub-alert code{padding:1px 5px;border-radius:5px;background:var(--chub-layer-2);font-size:13px}\n.chub-alert.err{border-color:color-mix(in srgb,var(--chub-err) 32%,transparent);background:color-mix(in srgb,var(--chub-err) 7%,var(--chub-layer-1))}\n.chub-alert.err b{color:var(--chub-err)}\n.chub-alert.info{border-color:color-mix(in srgb,var(--chub-accent) 32%,transparent);background:color-mix(in srgb,var(--chub-accent) 7%,var(--chub-layer-1))}\n.chub-alert.info b{color:var(--chub-accent)}\n.chub-filters{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border:1px solid var(--chub-line-soft);border-radius:13px;background:var(--chub-layer-1)}\n.chub-filterhead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}\n.chub-filterhead b{font-size:13.5px;font-weight:650}\n.chub-filterhead span{font-size:12.5px;color:var(--chub-text-3)}\n.chub-filterrow{display:flex;align-items:flex-end;gap:8px;flex-wrap:wrap}\n.chub-field{display:flex;flex-direction:column;gap:3px;flex:1 1 148px;min-width:0}\n.chub-field.grow{flex:2 1 210px}\n.chub-field>span{font-size:11.5px;line-height:1.4;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--chub-text-3)}\n.chub-field select,.chub-field input{width:100%;min-width:0;padding:5px 8px;border:1px solid var(--chub-line);border-radius:8px;background:var(--chub-layer-2);color:var(--chub-text);font:inherit;font-size:13.5px;line-height:1.5}\n.chub-field input::placeholder{color:var(--chub-text-3)}\n/* \u9875\u9762\u91CC\u552F\u4E00\u53EF\u6EDA\u52A8\u7684\u533A\u57DF\u3002\u6982\u89C8\u5934\u4E0E\u9875\u7B7E\u7559\u5728\u6EDA\u52A8\u5BB9\u5668\u4E4B\u5916\uFF0C\u5E38\u9A7B\u53EF\u89C1\u3002 */\n.chub-body{\n  display:flex;\n  flex-direction:column;\n  gap:14px;\n  min-height:0;\n  flex:1 1 auto;\n  padding-bottom:24px;\n  overflow-y:auto;\n  overflow-x:hidden;\n  scrollbar-gutter:stable;\n  animation:chub-in .28s ease both;\n}\n.chub-section{display:flex;flex-direction:column;gap:10px;min-width:0}\n.chub-sectionhead{display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap;padding-bottom:8px;border-bottom:1px solid var(--chub-line-soft)}\n.chub-sectionhead>div:first-child{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 320px}\n.chub-sectionhint{margin:0;font-size:13px;line-height:1.6;color:var(--chub-text-3)}\n.chub-sectools{display:flex;align-items:center;gap:6px;flex-wrap:wrap}\n/**\n * \u6E20\u9053\u5361\u7247\u7F51\u683C\u3002\n *\n * \u26A0\uFE0F `align-items:stretch`\uFF08\u539F\u6765\u662F `start`\uFF09\u662F\u6709\u610F\u7684\uFF1A\u5361\u7247\u9AD8\u5EA6\u7531**\u8D26\u53F7\u6570**\n * \u51B3\u5B9A\uFF0C\u800C\u7F51\u683C\u6309\u884C\u5BF9\u9F50\uFF0C`start` \u4F1A\u8BA9\u300C1 \u4E2A\u8D26\u53F7\u7684\u5361\u300D\u65C1\u8FB9\u90A3\u5F20\u300C2 \u4E2A\u8D26\u53F7\u7684\u5361\u300D\n * \u4E0B\u9762\u7559\u51FA\u4E00\u6574\u5757\u6B7B\u767D\uFF081440px \u5B9E\u6D4B 634px\uFF0C\u5176\u4E2D 502px \u4EC5\u6765\u81EA\u53CC\u8D26\u53F7\u5361\u4E0E\u5355\u8D26\u53F7\n * \u5361\u540C\u6392\uFF09\u3002\u6539\u6210 stretch \u540E\u884C\u5185\u5361\u7247\u7B49\u9AD8\uFF0C\u6B8B\u5DEE\u4EA4\u7ED9\u5361\u5185\u7684\u53EF\u4F38\u7F29\u5B50\u9879\u5438\u6536\u3002\n */\n.chub-channels{display:grid;grid-template-columns:repeat(auto-fill,minmax(380px,1fr));gap:12px;align-items:stretch}\n.chub-channel{\n  --chan-accent:var(--chub-accent);\n  position:relative;\n  display:flex;\n  flex-direction:column;\n  gap:10px;\n  min-width:0;\n  /* \u914D\u5408\u7F51\u683C\u7684 stretch\uFF1A\u5361\u7247\u5403\u6EE1\u884C\u9AD8\uFF0C\u5185\u90E8\u624D\u6709\u53EF\u5206\u914D\u7684\u5269\u4F59\u7A7A\u95F4\u3002 */\n  height:100%;\n  padding:15px 16px 13px;\n  overflow:hidden;\n  border:1px solid var(--chub-line-soft);\n  border-radius:15px;\n  background:linear-gradient(160deg,var(--chub-layer-2),var(--chub-layer-1));\n  transition:border-color .18s ease,transform .18s ease,box-shadow .18s ease;\n}\n/**\n * \u591A\u8D26\u53F7\u6E20\u9053\u7684\u5361\u7247**\u8DE8\u4E24\u5217**\u3002\n *\n * \u8FD9\u662F\u300C\u9AD8\u5EA6\u5DEE\u300D\u7684\u6839\u6CBB\u529E\u6CD5\uFF1A\u8D26\u53F7\u4ECE\u300C\u7EB5\u5411\u53E0\u51E0\u5757\u300D\u53D8\u6210\u300C\u6A2A\u5411\u6392\u51E0\u5217\u300D\uFF0C\u591A\u4E00\u4E2A\n * \u8D26\u53F7\u53EA\u591A\u4E00\u5217\u3001\u4E0D\u518D\u591A\u4E00\u6574\u5757\uFF0C\u9AD8\u5EA6\u5DEE\u88AB\u5BBD\u5EA6\u5438\u6536\u3002\u8DE8\u5217\u540E\u6BCF\u5361\u7EA6 640px\uFF0C\u4E24\u4E2A\n * \u8D26\u53F7\u5404\u7EA6 300px\uFF0C\u56DB\u4E2A\u64CD\u4F5C\u6309\u94AE\u4ECD\u6392\u5F97\u4E0B\u3002\n *\n * \u26A0\uFE0F \u5224\u5B9A\u7528\u7EC4\u4EF6\u7ED9\u51FA\u7684 `data-multi`\uFF08\u89C1 client.ts\uFF09\uFF0C**\u4E0D\u8981**\u6362\u6210\n * `:has(.chub-acct + .chub-acct)`\uFF1A\u540E\u8005\u628A\u5E03\u5C40\u5206\u652F\u7ED1\u5728\u6807\u8BB0\u7ED3\u6784\u4E0A\uFF0C\u8D26\u53F7\u5217\u8868\u91CC\n * \u53EA\u8981\u63D2\u5165\u4EFB\u4F55\u5144\u5F1F\u5143\u7D20\uFF08\u9519\u8BEF\u63D0\u793A\u3001\u5206\u7EC4\u6807\u9898\u3001\u6EDA\u52A8\u5BB9\u5668\uFF09\uFF0C`+` \u5C31\u5931\u6548\uFF0C\u5361\u7247\u4F1A\n * **\u9759\u9ED8**\u9000\u56DE\u5355\u5217 \u2014\u2014 \u4E0D\u62A5\u9519\u3001\u4E0D\u8B66\u544A\uFF0C\u53EA\u662F\u5E03\u5C40\u53D8\u4E86\u3002\n */\n.chub-channel[data-multi]{grid-column:span 2}\n/**\n * \u8DE8\u5217\u5361\u91CC\u7684\u8D26\u53F7\u5757\u5E76\u6392\u3002\n *\n * `auto-fit` \u8BA9\u5217\u6570\u968F\u53EF\u7528\u5BBD\u5EA6\u81EA\u52A8\u51B3\u5B9A\uFF1A640px \u7684\u5361\u91CC 2 \u4E2A\u8D26\u53F7\u5E76\u6392\u30013 \u4E2A\u8D26\u53F7\n * \u6392\u6210 3 \u5217\uFF0C\u4E0D\u4F1A\u9000\u5316\u6210\u300C2 + 1\u300D\u4E24\u884C\uFF1B`grid-auto-rows:1fr` \u4FDD\u8BC1\u540C\u4E00\u884C\u7684\u8D26\u53F7\u6846\n * \u7B49\u9AD8\uFF0C\u64CD\u4F5C\u6309\u94AE\u5E95\u8FB9\u5BF9\u9F50\u3002\n */\n.chub-channel[data-multi]>.chub-acctlist{\n  display:grid;\n  grid-template-columns:repeat(auto-fit,minmax(210px,1fr));\n  grid-auto-rows:1fr;\n  gap:7px;\n}\n.chub-channel::before{content:"";position:absolute;inset:0 0 auto;height:2px;background:linear-gradient(90deg,var(--chan-accent),transparent 76%);opacity:.72}\n.chub-channel[data-state=idle]::before{background:linear-gradient(90deg,var(--chub-warn),transparent 76%)}\n.chub-channel[data-state=err]::before{background:linear-gradient(90deg,var(--chub-err),transparent 76%)}\n.chub-channel[data-state=off]::before{background:linear-gradient(90deg,var(--chub-text-3),transparent 76%)}\n/**\n * \u5361\u7247\u5934\uFF1A\u5DE6\u7AEF\u662F\u6807\u9898\uFF0C\u53F3\u7AEF\u662F\u300C\u64CD\u4F5C\u6309\u94AE + \u72B6\u6001\u5FBD\u6807\u300D\u8FD9\u4E00\u4E2A\u6574\u4F53\u3002\n *\n * `.chub-chanheadend` \u6574\u4F53\u53C2\u4E0E\u6362\u884C\uFF08\u800C\u4E0D\u662F\u8BA9\u6309\u94AE\u4E0E\u5FBD\u6807\u5404\u81EA\u6362\u884C\uFF09\uFF1A\u7A84\u5361\u7247\u91CC\n * \u82E5\u53EA\u6709\u5FBD\u6807\u88AB\u6324\u5230\u7B2C\u4E8C\u884C\uFF0C\u6309\u94AE\u5C31\u4E0E\u5B83\u8131\u5F00\u4E86 \u2014\u2014 \u800C\u8FD9\u6B21\u7684\u8BC9\u6C42\u6B63\u662F\u300C\u6309\u94AE\u7D27\u6328\n * \u72B6\u6001\u5DE6\u4FA7\u300D\u3002Loomy \u6709\u4E24\u679A\u767B\u5F55\u6309\u94AE\uFF0C380px \u5361\u5BBD\u4E0B\u5FC5\u7136\u8D70\u5230\u6362\u884C\u5206\u652F\u3002\n */\n.chub-chanhead{display:flex;align-items:center;gap:6px 9px;flex-wrap:wrap;min-width:0}\n.chub-chanlogo{\n  display:inline-flex;\n  align-items:center;\n  justify-content:center;\n  width:32px;\n  height:32px;\n  flex:none;\n  border-radius:10px;\n  background:linear-gradient(145deg,color-mix(in srgb,var(--chan-accent) 82%,#fff),color-mix(in srgb,var(--chan-accent) 54%,#07111f));\n  color:#fff;\n  font-size:12.5px;\n  font-weight:760;\n  letter-spacing:.02em;\n  box-shadow:inset 0 1px 0 rgba(255,255,255,.24),0 4px 10px color-mix(in srgb,var(--chan-accent) 18%,transparent);\n}\n.chub-chanid{display:flex;flex-direction:column;gap:0;min-width:0;flex:1}\n.chub-chanid b{font-size:15px;line-height:1.45;font-weight:680;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.chub-chanid span{font-size:12px;line-height:1.45;color:var(--chub-text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.chub-chanstate{display:inline-flex;align-items:center;gap:4px;flex:none;padding:2px 7px;border:1px solid var(--chub-line-soft);border-radius:999px;color:var(--chub-text-3);font-size:11.5px;font-weight:600;line-height:1.5;white-space:nowrap}\n.chub-chanstate::before{content:"";width:4px;height:4px;border-radius:50%;background:currentColor}\n.chub-channel[data-state=on] .chub-chanstate{color:var(--chub-ok);border-color:color-mix(in srgb,var(--chub-ok) 26%,transparent);background:color-mix(in srgb,var(--chub-ok) 7%,transparent)}\n.chub-channel[data-state=idle] .chub-chanstate{color:var(--chub-warn);border-color:color-mix(in srgb,var(--chub-warn) 26%,transparent);background:color-mix(in srgb,var(--chub-warn) 7%,transparent)}\n.chub-channel[data-state=err] .chub-chanstate{color:var(--chub-err);border-color:color-mix(in srgb,var(--chub-err) 28%,transparent);background:color-mix(in srgb,var(--chub-err) 7%,transparent)}\n/**\n * \u5361\u7247\u7EDF\u8BA1\u884C\uFF1A\u53EA\u6709\u8BFB\u6570\uFF0C\u4E0D\u518D\u627F\u8F7D\u6309\u94AE\u3002\n *\n * \u300C\u6DFB\u52A0\u8D26\u53F7 / \u52A0\u5165\u6E20\u9053\u300D\u8FD9\u7C7B\u4E3B\u64CD\u4F5C\u5DF2\u4E0A\u79FB\u5230\u5361\u7247\u5934\uFF0C\u7D27\u8D34\u72B6\u6001\u5FBD\u6807\u5DE6\u4FA7\n * \uFF08\u89C1 client.ts \u7684 `.chub-chanheadacts`\uFF09\u3002\u7EDF\u8BA1\u884C\u56E0\u6B64\u662F\u7EAF\u7CB9\u7684\u8BFB\u6570\u884C\uFF0C\n * \u4E0D\u9700\u8981\u4EFB\u4F55\u53F3\u63A8\u7559\u767D \u2014\u2014 \u7559\u767D\u4F1A\u81EA\u52A8\u843D\u5728\u884C\u5C3E\u3002\n *\n * \u26A0\uFE0F `flex-wrap:nowrap` \u662F\u957F\u6635\u79F0\u90A3\u4E2A\u7F3A\u9677\u7684\u6838\u5FC3\u4FEE\u590D\uFF1A\u8FD9\u4E9B\u8BFB\u6570\u9879\u90FD\u662F\u77ED\u5C0F\u7684\n * \u56FA\u5B9A\u6587\u5B57\uFF08`\u8D26\u53F7 1/1`\u3001`\u6A21\u578B 2`\u3001`\u76EE\u5F55 \xB7 20 \u5206\u949F\u524D`\uFF09\uFF0C\u6574\u884C\u672C\u6765\u5C31\u8BE5\u662F\u4E00\u884C\u3002\n * \u5141\u8BB8\u6362\u884C\u7684\u540E\u679C\u662F\u300C`select` \u957F\u4E00\u70B9\uFF0C\u6574\u7EC4\u8BFB\u6570\u5C31\u88AB\u6324\u5230\u4E0B\u4E00\u884C\u300D\u2014\u2014\u7528\u6237\u62A5\u7684\n * \u300C\u6324\u538B\u5176\u5B83\u6587\u5B57\u300D\u5C31\u662F\u5B83\u3002\u8BA9\u6B65\u7531 `.chub-account-choice` \u5355\u5411\u627F\u62C5\u3002\n * \u7A84\u5361\u7247\uFF08<420px\uFF09\u4E0B\u7684\u515C\u5E95\u89C1 `@container chan`\u3002\n */\n.chub-chanmeta{display:flex;align-items:center;gap:4px 9px;flex-wrap:nowrap;padding:5px 0 1px;border-top:1px dashed var(--chub-line-soft);font-size:12px;line-height:1.5;color:var(--chub-text-3)}\n/**\n * \u8BFB\u6570\u9879\u7D27\u8DDF\u5728\u300C\u4F7F\u7528\u8D26\u53F7\u300D\u540E\u9762\uFF08\u4E0D\u662F\u9760\u53F3\uFF09\uFF1A\u5B83\u4EEC\u662F\u7EAF\u8BFB\u6570\uFF0C\u9760\u53F3\u4F1A\u8BA9\u6574\u884C\u770B\u8D77\u6765\n * \u50CF\u4E24\u4E2A\u4E92\u4E0D\u76F8\u5E72\u7684\u7EC4\u3002`margin-left:auto` \u5168\u884C\u90FD\u6CA1\u6709\uFF0C\u7559\u767D\u81EA\u52A8\u843D\u5728\u884C\u5C3E\u3002\n */\n.chub-chanmeta>b,.chub-chanmeta>span{flex:none}\n.chub-chanmeta b{font-weight:650;color:var(--chub-text-2);font-variant-numeric:tabular-nums}\n.chub-chanmeta .warn{color:var(--chub-warn)}\n/**\n * \u5361\u7247\u5934\u53F3\u7AEF\u7684\u6574\u4F53\u5757\uFF1A\u64CD\u4F5C\u7EC4 + \u72B6\u6001\u5FBD\u6807\u3002\n *\n * `flex:none` + `margin-left:auto`\uFF1A\u6574\u4F53\u8D34\u53F3\u8FB9\u7F18\uFF0C\u5185\u90E8\u4E24\u679A\u5143\u7D20\u4FDD\u6301\u76F8\u90BB\uFF1B\n * \u6362\u884C\u65F6\u6574\u5757\u4E00\u8D77\u4E0B\u79FB\uFF0C\u4E0D\u4F1A\u53EA\u5269\u5FBD\u6807\u5B64\u96F6\u96F6\u843D\u5728\u7B2C\u4E8C\u884C\u3002\n */\n.chub-chanheadend{display:flex;align-items:center;gap:7px;flex:none;margin-left:auto}\n/**\n * \u5361\u7247\u5934\u91CC\u7684\u64CD\u4F5C\u7EC4\uFF1A\u7D27\u6328\u5728\u72B6\u6001\u5FBD\u6807**\u5DE6\u4FA7**\u3002\n *\n * `flex:none`\uFF08\u4E0D\u53EF\u538B\u7F29\uFF09\u662F\u5173\u952E\uFF1A\u5141\u8BB8\u6536\u7F29\u4F1A\u8BA9\u7A84\u5361\u7247\u91CC\u7684\u6309\u94AE\u6324\u6210\u4E00\u5217\u3001\n * \u6587\u5B57\u88AB\u538B\u51FA\u6309\u94AE\u6846\u3002\u8BA9\u6807\u9898\u5757\uFF08`.chub-chanid`\uFF0C`min-width:0` + \u7701\u7565\u53F7\uFF09\n * \u53BB\u627F\u62C5\u538B\u7F29\uFF0C\u6309\u94AE\u6C38\u8FDC\u4FDD\u6301\u5B8C\u6574\u53EF\u70B9\u3002\n */\n.chub-chanhead>.chub-chanid{flex:1 1 120px}\n.chub-chanacts{display:flex;align-items:center;gap:5px;flex-wrap:wrap}\n.chub-smsform{display:flex;flex-direction:column;gap:7px;padding:10px 11px;border:1px solid var(--chub-line-soft);border-radius:12px;background:var(--chub-layer-1)}\n.chub-smsform .chub-smsfields{display:flex;gap:8px;flex-wrap:wrap}\n.chub-smsform .chub-field{flex:1 1 132px}\n/**\n * \u8D26\u53F7\u5217\u8868\u3002\n *\n * `flex:1 1 auto` + `min-height:0` \u8BA9\u8D26\u53F7\u5217\u8868\u5403\u6389\u5361\u7247\u7684\u5269\u4F59\u9AD8\u5EA6\uFF1A\u884C\u5185\u7B49\u9AD8\n * \u62C9\u51FA\u6765\u7684\u90A3\u51E0\u50CF\u7D20\u843D\u5728\u8D26\u53F7\u6846\u91CC\uFF0C\u518D\u7531 `.chub-acctacts{margin-top:auto}` \u628A\n * \u64CD\u4F5C\u884C\u63A8\u5230\u8D26\u53F7\u6846\u5E95\u8FB9 \u2014\u2014 \u7A7A\u767D\u56E0\u6B64\u6C89\u8FDB\u8D26\u53F7\u6846\u5185\u90E8\uFF0C\u800C\u4E0D\u662F\u5361\u5E95\u4E00\u5757\u767D\u3002\n */\n.chub-acctlist{display:flex;flex-direction:column;gap:7px;flex:1 1 auto;min-height:0}\n.chub-acct{\n  display:flex;\n  flex-direction:column;\n  gap:7px;\n  min-width:0;\n  padding:9px 10px;\n  border:1px solid var(--chub-line-soft);\n  border-radius:11px;\n  background:color-mix(in srgb,var(--chub-layer-1) 82%,transparent);\n}\n.chub-acct:has(input:focus-visible){border-color:color-mix(in srgb,var(--chub-accent) 48%,var(--chub-line))}\n.chub-accthead{display:flex;align-items:center;gap:7px;min-width:0}\n.chub-avatar{display:inline-flex;align-items:center;justify-content:center;width:23px;height:23px;flex:none;border-radius:7px;background:color-mix(in srgb,var(--chan-accent) 16%,var(--chub-layer-2));color:var(--chan-accent);font-size:11px;font-weight:720}\n.chub-acctid{display:flex;flex-direction:column;gap:0;min-width:0;flex:1}\n.chub-acctid b{font-size:13.5px;line-height:1.5;font-weight:640;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.chub-acctid span{font-size:11.5px;line-height:1.45;color:var(--chub-text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.chub-acctid i{font-style:normal}\n.chub-acctid i.warn{color:var(--chub-warn)}\n.chub-acctid i.err{color:var(--chub-err)}\n.chub-acctbadges{display:flex;align-items:center;gap:4px;flex-wrap:wrap;justify-content:flex-end}\n.chub-badge{display:inline-flex;align-items:center;padding:1px 6px;border:1px solid var(--chub-line-soft);border-radius:999px;background:var(--chub-layer-1);color:var(--chub-text-3);font-size:11px;line-height:1.5;font-weight:600;white-space:nowrap}\n.chub-badge.ok{color:var(--chub-ok);border-color:color-mix(in srgb,var(--chub-ok) 24%,transparent);background:color-mix(in srgb,var(--chub-ok) 7%,transparent)}\n.chub-badge.warn{color:var(--chub-warn);border-color:color-mix(in srgb,var(--chub-warn) 24%,transparent);background:color-mix(in srgb,var(--chub-warn) 7%,transparent)}\n.chub-badge.err{color:var(--chub-err);border-color:color-mix(in srgb,var(--chub-err) 26%,transparent);background:color-mix(in srgb,var(--chub-err) 7%,transparent)}\n.chub-acctmeta{display:flex;align-items:center;gap:3px 8px;flex-wrap:wrap;font-size:11.5px;line-height:1.5;color:var(--chub-text-3)}\n.chub-acctmeta b{font-weight:650;color:var(--chub-text-2)}\n.chub-acctmeta .warn{color:var(--chub-warn)}\n.chub-acctmeta .err{color:var(--chub-err)}\n/* \u989D\u5EA6\u8BFB\u6570\uFF1A\u6570\u503C\u4E0E\u5355\u4F4D\u5728\u5BBF\u4E3B\u4FA7\u62FC\u597D\uFF08core/credits.ts\uFF09\uFF0C\u8FD9\u91CC\u53EA\u6392\u7248\u3002 */\n.chub-credits{display:flex;flex-direction:column;gap:4px;min-width:0}\n.chub-creditline{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;line-height:1.5;color:var(--chub-text-2)}\n.chub-creditline>b{font-weight:680;font-variant-numeric:tabular-nums;color:var(--chub-text)}\n.chub-creditline .chub-creditlabel{font-size:11.5px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--chub-text-3)}\n.chub-creditline .err{color:var(--chub-err)}\n.chub-creditline .muted{color:var(--chub-text-3)}\n.chub-credittag{flex:none;padding:0 5px;border:1px solid color-mix(in srgb,var(--chan-accent) 22%,transparent);border-radius:999px;background:color-mix(in srgb,var(--chan-accent) 9%,transparent);color:color-mix(in srgb,var(--chan-accent) 66%,var(--chub-text));font-size:11px;font-weight:600;line-height:1.6;white-space:nowrap}\n.chub-creditbar{height:4px;overflow:hidden;border-radius:2px;background:var(--chub-layer-3)}\n.chub-creditbar>i{display:block;height:100%;border-radius:inherit;background:var(--chan-accent)}\n.chub-creditbar.low>i{background:var(--chub-warn)}\n.chub-creditnote{margin:0;font-size:11.5px;line-height:1.5;color:var(--chub-text-3);overflow-wrap:anywhere}\n.chub-creditnote.err{color:var(--chub-err)}\n.chub-pkgs{display:flex;flex-direction:column;gap:5px;padding-top:5px}\n.chub-pkg{display:flex;flex-direction:column;gap:3px;min-width:0;padding:5px 7px;border-radius:7px;background:color-mix(in srgb,var(--chub-layer-2) 62%,transparent)}\n.chub-pkg.off{opacity:.5}\n.chub-pkghead{display:flex;align-items:baseline;gap:6px;min-width:0;font-size:11.5px;line-height:1.5;color:var(--chub-text-3)}\n.chub-pkgname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--chub-text-2);font-weight:600}\n.chub-pkgval{flex:none;font-variant-numeric:tabular-nums;color:var(--chub-text-2)}\n.chub-pkgwhen{flex:none;font-variant-numeric:tabular-nums;color:var(--chub-text-3);white-space:nowrap}\n/**\n * \u8D26\u53F7\u64CD\u4F5C\u884C\u3002\n *\n * `margin-top:auto` \u628A\u6309\u94AE\u63A8\u5230\u8D26\u53F7\u6846\u5E95\u8FB9\uFF1A\u8D26\u53F7\u6846\u88AB\u62C9\u9AD8\u65F6\uFF0C\u591A\u51FA\u6765\u7684\u9AD8\u5EA6\u843D\u5728\n * \u300C\u6A21\u578B\u6298\u53E0 \u2194 \u64CD\u4F5C\u884C\u300D\u4E4B\u95F4\uFF08\u8D26\u53F7\u6846\u5185\u90E8\uFF09\uFF0C\u800C\u4E0D\u662F\u5806\u5230\u5361\u7247\u5E95\u90E8\u5F62\u6210\u4E00\u5757\u767D\u3002\n * \u540C\u4E00\u884C\u7684\u8D26\u53F7\u6846\u56E0\u4E3A `grid-auto-rows:1fr` \u7B49\u9AD8\uFF0C\u64CD\u4F5C\u884C\u4E5F\u5C31\u5E95\u8FB9\u5BF9\u9F50\u3002\n */\n.chub-acctacts{display:flex;align-items:center;gap:3px;flex-wrap:wrap;margin-top:auto}\n.chub-inline{margin:0;font-size:12.5px;line-height:1.6;color:var(--chub-text-2);overflow-wrap:anywhere}\n.chub-inline.err{color:var(--chub-err)}\n.chub-inline.muted{color:var(--chub-text-3)}\n.chub-models summary,.chub-fold summary{display:flex;align-items:center;gap:6px;list-style:none;cursor:pointer;color:var(--chub-text-2);font-size:12.5px;line-height:1.5}\n.chub-models summary::-webkit-details-marker,.chub-fold summary::-webkit-details-marker{display:none}\n.chub-models summary::before,.chub-fold summary::before{content:"\u203A";display:inline-block;color:var(--chub-text-3);font-size:16px;line-height:1;transition:transform .15s ease;transform:translateY(-1px)}\n.chub-models[open] summary::before,.chub-fold[open] summary::before{transform:rotate(90deg) translateX(-1px)}\n.chub-models summary{padding:5px 7px;border:1px solid var(--chub-line-soft);border-radius:8px;background:var(--chub-layer-1)}\n.chub-models summary:hover{border-color:color-mix(in srgb,var(--chan-accent) 34%,var(--chub-line))}\n.chub-summaryhint{margin-left:auto;font-size:11.5px;font-weight:400;color:var(--chub-text-3);text-align:right}\n.chub-modelacts{display:flex;align-items:center;gap:4px;padding:7px 2px 1px;flex-wrap:wrap}\n.chub-modelacthint{margin-right:auto;color:var(--chub-text-3);font-size:11.5px}\n.chub-modellist{display:grid;grid-template-columns:1fr;gap:3px;padding-top:6px}\n.chub-model{display:flex;align-items:center;gap:6px;min-width:0;padding:5px 7px;border-radius:6px;background:color-mix(in srgb,var(--chub-layer-2) 66%,transparent);font-size:12px;line-height:1.5;cursor:pointer}\n.chub-model:hover{background:var(--chub-layer-2)}\n.chub-model.off{opacity:.48}\n.chub-model input{width:13px;height:13px;margin:0;flex:none;accent-color:var(--chub-accent)}\n.chub-modelname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--chub-text-2)}\n.chub-promo{flex:none;padding:0 5px;border-radius:999px;background:color-mix(in srgb,var(--chub-warn) 14%,transparent);color:color-mix(in srgb,var(--chub-warn) 80%,var(--chub-text));font-size:11px;font-weight:600;line-height:1.6;letter-spacing:0;white-space:nowrap}\n.chub-factor{flex:none;padding:0 5px;border:1px solid color-mix(in srgb,var(--chan-accent) 22%,transparent);border-radius:999px;background:color-mix(in srgb,var(--chan-accent) 10%,var(--chub-layer-2));color:color-mix(in srgb,var(--chan-accent) 68%,var(--chub-text));font-size:11px;font-weight:650;line-height:1.6;font-variant-numeric:tabular-nums;letter-spacing:0;white-space:nowrap}\n/* \u4E0A\u4E0B\u6587\u6863\u4F4D\u5FBD\u6807\uFF1A\u672A\u542F\u7528\u65F6\u865A\u7EBF\u5F31\u5316\uFF0C\u542F\u7528\u540E\u5B9E\u5FC3 \u2014\u2014 \u4E00\u773C\u533A\u5206\u300C\u80FD\u5F00\u300D\u4E0E\u300C\u5DF2\u5F00\u300D\u3002\n   \u4E0E .chub-factor \u5E76\u5217\u5728\u6A21\u578B\u884C\u5C3E\uFF0C\u5BBD\u5EA6\u6709\u9650\u6545\u53EA\u653E\u7A97\u53E3\u6570\u503C\uFF081M / 200K\uFF09\u3002 */\n.chub-tier{flex:none;padding:0 5px;border:1px dashed color-mix(in srgb,var(--chub-text-3) 46%,transparent);border-radius:999px;background:transparent;color:var(--chub-text-3);font-size:11px;font-weight:600;line-height:1.6;font-variant-numeric:tabular-nums;letter-spacing:0;white-space:nowrap}\n.chub-tier.on{border-style:solid;border-color:color-mix(in srgb,var(--chub-accent) 40%,transparent);background:color-mix(in srgb,var(--chub-accent) 14%,var(--chub-layer-2));color:color-mix(in srgb,var(--chub-accent) 72%,var(--chub-text))}\n/* \u5927\u7A97\u53E3\u6863\u5F00\u5173\uFF1A\u4E0E\u300C\u8D26\u53F7 N/M\u300D\u300C\u6A21\u578B N\u300D\u540C\u6392\u3002\u4E0D\u62A2\u7A7A\u95F4\uFF0C\u9760 .chub-chanacts \u7684\n   margin-left:auto \u8BA9\u6309\u94AE\u7EC4\u7559\u5728\u884C\u5C3E\u3002 */\n.chub-context-toggle{display:inline-flex;align-items:center;gap:4px;flex:none;font-size:12px;line-height:1.5;color:var(--chub-text-3);cursor:pointer;white-space:nowrap}\n.chub-context-toggle input{width:13px;height:13px;margin:0;flex:none;accent-color:var(--chub-accent)}\n.chub-context-toggle:hover{color:var(--chub-text-2)}\n.chub-panel{display:flex;flex-direction:column;gap:10px;min-width:0;padding:14px 15px;border:1px solid var(--chub-line-soft);border-radius:14px;background:linear-gradient(160deg,var(--chub-layer-1),color-mix(in srgb,var(--chub-layer-1) 62%,transparent))}\n.chub-panelhead{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap}\n.chub-panelhead>div:first-child{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1 1 280px}\n.chub-panelhead p{margin:0;font-size:12.5px;line-height:1.55;color:var(--chub-text-3)}\n.chub-panelhint{font-size:12px;color:var(--chub-text-3);white-space:nowrap}\n/* 6 \u5F20\u5361\u5728\u5BBD\u5C4F\u6309 3 \u5217\u6392\u6EE1\u4E24\u884C\uFF1Bauto-fit \u4F1A\u5728 1240px \u4E0B\u6392\u51FA 5+1 \u7684\u5B64\u884C\u3002 */\n.chub-kpis{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}\n.chub-kpi{display:flex;flex-direction:column;gap:1px;min-width:0;padding:12px 13px;border:1px solid var(--chub-line-soft);border-radius:12px;background:linear-gradient(165deg,var(--chub-layer-2),var(--chub-layer-1))}\n.chub-kpilabel{font-size:11.5px;line-height:1.4;font-weight:650;letter-spacing:.08em;text-transform:uppercase;color:var(--chub-text-3)}\n.chub-kpivalue{font-size:28px;line-height:1.2;font-weight:760;letter-spacing:-.025em;font-variant-numeric:tabular-nums;background:linear-gradient(110deg,var(--chub-text),color-mix(in srgb,var(--chub-accent) 68%,var(--chub-text)));-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;overflow-wrap:anywhere}\n.chub-kpisub{font-size:12px;line-height:1.5;color:var(--chub-text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.chub-notes{display:flex;align-items:center;gap:4px 12px;flex-wrap:wrap;padding:8px 11px;border:1px dashed var(--chub-line-soft);border-radius:10px;font-size:12.5px;line-height:1.5;color:var(--chub-text-3)}\n.chub-notes b{font-weight:650;color:var(--chub-text-2)}\n.chub-chartbody{display:flex;flex-direction:column;gap:4px;padding-top:2px}\n.chub-chartsvg{display:block;width:100%;height:150px;overflow:visible}\n.chub-bar{transition:opacity .15s ease}\n.chub-bar:hover{opacity:1}\n/**\n * \u5806\u53E0\u67F1\u7684\u6BCF\u4E00\u6BB5\u3002\n *\n * \u26A0\uFE0F \u989C\u8272\u7531\u7EC4\u4EF6\u6309\u6E20\u9053**\u5185\u8054**\u7ED9\u51FA\uFF08fill \u5C5E\u6027\uFF09\uFF0C\u56E0\u4E3A\u6E20\u9053\u96C6\u5408\u662F\u52A8\u6001\u7684\u3001\n * \u6570\u91CF\u4E0D\u5B9A\uFF0C\u5199\u6B7B\u5728 CSS \u91CC\u4F1A\u51FA\u73B0\u300C\u7B2C 11 \u4E2A\u6E20\u9053\u6CA1\u6709\u989C\u8272\u300D\u3002\u8FD9\u91CC\u53EA\u8D1F\u8D23\n * \u60AC\u505C\u53CD\u9988\u3002\n */\n.chub-seg{transition:opacity .15s ease}\n.chub-seg:hover{opacity:.82}\n/**\n * \u56FE\u4F8B\uFF1A\u6E20\u9053 \u2192 \u8272\u5757\u3002\n *\n * \u81EA\u52A8\u6362\u884C\uFF1B\u6E20\u9053\u591A\u65F6\u4E5F\u4E0D\u4F1A\u628A\u56FE\u8868\u6324\u8D70\u3002\u8272\u5757\u4E0E\u67F1\u6BB5\u7528\u540C\u4E00\u4E2A\u989C\u8272\u6E90\u3002\n */\n.chub-legend{display:flex;align-items:center;gap:4px 12px;flex-wrap:wrap;padding-top:6px;font-size:11.5px;line-height:1.5;color:var(--chub-text-3)}\n.chub-legenditem{display:inline-flex;align-items:center;gap:5px;min-width:0}\n.chub-legenddot{flex:none;width:9px;height:9px;border-radius:3px}\n.chub-legendname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:12em}\n/* \u56FE\u4F8B\u91CC\u7684\u533A\u95F4\u5408\u8BA1\uFF1A\u4E0E\u6E20\u9053\u540D\u533A\u5206\u5F00\uFF0C\u6570\u5B57\u7528\u7B49\u5BBD\u5B57\u5F62\u907F\u514D\u6296\u52A8\u3002 */\n.chub-legendvalue{flex:none;color:var(--chub-text-2);font-variant-numeric:tabular-nums}\n/**\n * \u56FE\u4F8B\u5F00\u5934\u7684\u300C\u5408\u8BA1\u300D\uFF1A\u8BF4\u660E\u56FE\u4F8B\u6570\u5B57\u7684\u53E3\u5F84\u662F**\u6574\u4E2A\u7B5B\u9009\u533A\u95F4**\uFF0C\n * \u800C\u67F1\u5B50\u662F\u6BCF\u65E5\u7684\u91CF \u2014\u2014 \u4E24\u8005\u91CF\u7EA7\u4E0D\u540C\uFF0C\u4E0D\u5199\u6E05\u4F1A\u8BA9\u4EBA\u4EE5\u4E3A\u6570\u5B57\u5BF9\u4E0D\u4E0A\u3002\n */\n.chub-legendtotal{display:inline-flex;align-items:baseline;gap:4px;flex:none;padding-right:10px;margin-right:2px;border-right:1px solid var(--chub-line-soft);color:var(--chub-text-3);font-size:11.5px;white-space:nowrap}\n.chub-legendtotal b{font-size:12.5px;font-weight:700;color:var(--chub-text);font-variant-numeric:tabular-nums}\n.chub-gridline{stroke:var(--chub-line-soft);stroke-width:1;stroke-dasharray:3 5}\n/* \u6807\u7B7E\u6309\u67F1\u5B50\u683C\u6570\u7B49\u5206\uFF0C\u6BCF\u683C\u5C45\u4E2D \u2014\u2014 \u4E0E SVG \u91CC\u300C\u67F1\u5FC3 = \u683C\u4E2D\u70B9\u300D\u4E25\u683C\u5BF9\u9F50\u3002 */\n.chub-axis{display:grid;align-items:center;gap:0;font-size:11.5px;color:var(--chub-text-3);font-variant-numeric:tabular-nums}\n.chub-axis span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center}\n/**\n * \u8D26\u53F7\u900F\u89C6\u4E0E\u6A21\u578B\u6027\u80FD\uFF1A**\u4E0A\u4E0B\u5404\u5360\u4E00\u6574\u884C**\u3002\n *\n * \u26A0\uFE0F \u539F\u5B9E\u73B0\u662F auto-fit + minmax(430px,1fr) \u7684\u53CC\u680F\uFF08\u7528\u6237 2026-10-21 \u8981\u6C42\u6539\u6210\n * \u4E0D\u8981\u5E76\u6392\uFF09\u3002\u8FD9\u4E24\u5F20\u8868\u90FD\u662F 7 \u5217\uFF0C\u6324\u5728\u534A\u5BBD\u91CC\u6BCF\u4E2A\u5355\u5143\u683C\u90FD\u53D8\u7A84\u3001\u6A21\u578B\u540D\u4E0E\u8D26\u53F7\u540D\n * \u9891\u7E41\u6298\u884C\uFF1B\u800C\u6574\u7A97\u9762\u677F\u672C\u6765\u5C31\u6709\u5145\u8DB3\u6A2A\u5411\u7A7A\u95F4\uFF0C\u53CC\u680F\u7EAF\u5C5E\u6D6A\u8D39\u3002\n * \u6539\u6210\u5355\u5217\u540E\u6BCF\u5F20\u8868\u90FD\u62FF\u5230\u5B8C\u6574\u5BBD\u5EA6\uFF0C\u884C\u9AD8\u4E5F\u66F4\u7A33\u5B9A\u3002\n */\n.chub-stack{display:flex;flex-direction:column;gap:10px}\n.chub-stack>section{display:flex;flex-direction:column;min-width:0}\n/**\n * \u770B\u677F\u91CC\u8FD9\u4E24\u5F20\u6C47\u603B\u8868\u4E0D\u5FC5\u62C9\u6EE1\u6574\u884C\u3002\n *\n * \u26A0\uFE0F \u6539\u6210\u4E0A\u4E0B\u5806\u53E0\u540E\u51FA\u73B0\u7684\u65B0\u95EE\u9898\uFF082560px \u5B9E\u6D4B\uFF09\uFF1A\u8868\u683C\u7EE7\u627F width:100%\uFF0C\n * 7 \u5217\u88AB\u644A\u5230 2500px \u5BBD\uFF0C\u5217\u95F4\u7559\u51FA\u5927\u7247\u7A7A\u767D\uFF0C\u6570\u5B57\u4E0E\u8868\u5934\u79BB\u5F97\u5F88\u8FDC\u53CD\u800C\u96BE\u8BFB\u3002\n * \u7ED9\u4E00\u4E2A**\u4E0A\u9650**\u8BA9\u5B83\u4EEC\u505C\u5728\u4FBF\u4E8E\u626B\u8BFB\u7684\u5BBD\u5EA6\uFF1B\u7A97\u53E3\u7A84\u4E8E\u8BE5\u503C\u65F6\u4ECD\u81EA\u9002\u5E94\u6536\u7F29\u3002\n * \u53EA\u4F5C\u7528\u4E8E .chub-stack \u5185\u7684\u8868\uFF0C\u8FD0\u884C\u65E5\u5FD7\u90A3\u79CD\u771F\u6B63\u9700\u8981\u5BBD\u5EA6\u7684\u8868\u4E0D\u53D7\u5F71\u54CD\u3002\n */\n.chub-stack .chub-scroll>table{max-width:1180px}\n/**\n * \u300C\u6765\u6E90 / \u540D\u79F0\u300D\u4E24\u6BB5\u5F0F\u5355\u5143\u683C\u3002\n *\n * \u6765\u6E90\u662F\u5206\u7C7B\u4FE1\u606F\u3001\u540D\u79F0\u624D\u662F\u4E3B\u4F53\uFF0C\u6545\u6765\u6E90\u5F31\u5316\u4E00\u6863\uFF1B\u5206\u9694\u7B26\u518D\u6DE1\u4E00\u6863\uFF0C\u907F\u514D\n * \u300Cqoder / \u67D0\u8D26\u53F7\u300D\u88AB\u8BFB\u6210\u4E00\u6574\u4E32\u3002\n */\n.chub-source{display:inline-flex;align-items:baseline;gap:0;min-width:0}\n.chub-source .chub-sep{color:var(--chub-text-3);opacity:.7}\n.chub-source{color:var(--chub-text)}\n.chub-source>.chub-sep+*{color:var(--chub-text-2)}\n.chub-fold{margin-top:1px;padding-top:7px;border-top:1px dashed var(--chub-line-soft)}\n.chub-pre{max-height:210px;margin:5px 0 0;padding:9px 10px;overflow:auto;border-radius:9px;background:var(--chub-layer-1);font-size:12px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}\n/**\n * \u8868\u683C\uFF1A**\u6D88\u9664\u6A2A\u5411\u6EDA\u52A8**\u3002\n *\n * \u539F\u5B9E\u73B0\u7ED9\u6BCF\u4E2A td \u90FD\u52A0 white-space:nowrap\uFF0C\u77ED\u5185\u5BB9\uFF08\u65F6\u95F4\u3001\u6570\u5B57\u3001\u72B6\u6001\uFF09\u786E\u5B9E\n * \u597D\u770B\uFF0C\u4F46\u957F\u5185\u5BB9\uFF08\u6A21\u578B\u540D\u3001\u6E20\u9053\u540D\u3001\u8D26\u53F7\u6807\u7B7E\uFF09\u4F1A\u628A\u8868\u683C\u6491\u51FA\u5BB9\u5668\u5BBD\u5EA6\uFF0C\u4E8E\u662F\u6BCF\u6B21\n * \u90FD\u5192\u51FA\u4E00\u6761\u6A2A\u5411\u6EDA\u52A8\u6761 \u2014\u2014 \u7528\u6237\u660E\u786E\u8981\u6C42\u5C3D\u91CF\u51CF\u5C11\u5B83\u3002\n *\n * \u505A\u6CD5\uFF1A\u9ED8\u8BA4\u5141\u8BB8\u6362\u884C\uFF0C\u53EA\u8BA9**\u771F\u6B63\u77ED\u7684\u5217**\u4FDD\u6301 nowrap\uFF08\u89C1 td.nowrap \u4E0E\u8868\u5934\uFF09\u3002\n * \u6362\u884C\u4F18\u5148\u4E8E\u6A2A\u5411\u6EDA\u52A8\uFF1A\u5B81\u53EF\u591A\u5360\u4E00\u884C\u9AD8\u5EA6\uFF0C\u4E5F\u4E0D\u8BA9\u7528\u6237\u5DE6\u53F3\u62D6\u52A8\u3002\n *\n * \u26A0\uFE0F overflow-x:auto \u4FDD\u7559\u4E3A**\u515C\u5E95**\uFF1A\u6781\u7AEF\u7A84\u7A97\u53E3\u4E0B\u82E5\u67D0\u5217\u5B9E\u5728\u653E\u4E0D\u4E0B\uFF0C\u81F3\u5C11\u8FD8\n * \u6EDA\u5F97\u52A8\uFF0C\u800C\u4E0D\u662F\u5185\u5BB9\u88AB\u88C1\u6389\u770B\u4E0D\u89C1\u3002\n */\n.chub-scroll{table-layout:auto;overflow-x:auto;overflow-y:hidden;border:1px solid var(--chub-line-soft);border-radius:11px;background:color-mix(in srgb,var(--chub-layer-1) 55%,transparent)}\n.chub-panel>.chub-scroll{border-color:transparent;background:transparent}\n.chub-scroll table{width:100%;border-collapse:collapse;font-size:13px;line-height:1.45}\n.chub-scroll th{position:sticky;top:0;z-index:1;padding:7px 9px;border-bottom:1px solid var(--chub-line);background:var(--chub-layer-2);color:var(--chub-text-3);font-size:11.5px;font-weight:650;letter-spacing:.03em;text-align:left;white-space:nowrap}\n/* \u5355\u5143\u683C\u9ED8\u8BA4\u6362\u884C\uFF0C\u4F46\u53EA\u5728**\u8BCD\u8FB9\u754C**\u65AD\uFF0C\u4E0D\u628A\u5355\u8BCD\u62C6\u6210\u5355\u5B57\u7B26\u3002 */\n/* \u5355\u5143\u683C\u9ED8\u8BA4\u5782\u76F4\u5C45\u4E2D\uFF1A\u884C\u9AD8\u7531\u6700\u9AD8\u7684\u683C\u5B50\u51B3\u5B9A\uFF0C\u5176\u4F59\u683C\u5B50\u4E0E\u5B83\u5C45\u4E2D\u5BF9\u9F50\u3002 */\n.chub-scroll td{padding:6px 9px;border-top:1px solid var(--chub-line-soft);color:var(--chub-text-2);text-align:left;vertical-align:middle;overflow-wrap:break-word}\n/*\n * \u957F\u6587\u672C\u5217\uFF08\u6E20\u9053 / \u6A21\u578B\u3001\u8D26\u53F7\uFF09\u7ED9\u4E00\u4E2A\u4E0B\u9650\u3002\n *\n * \u26A0\uFE0F \u771F\u5B9E\u7F3A\u9677\uFF081280px \u590D\u73B0\uFF09\uFF1A\u4E0D\u8BBE min-width \u65F6\u8868\u683C\u4F1A\u628A\u5269\u4F59\u5BBD\u5EA6\u644A\u7ED9\u6BCF\u5217\uFF0C\n * \u957F\u8D26\u53F7\u88AB\u538B\u5230\u51E0\u5341\u50CF\u7D20\uFF0C\u4E8E\u662F\u90AE\u7BB1\u5730\u5740\u7AD6\u6392\u6210\u4E00\u5217\u5355\u5B57\u7B26\uFF08rebe / lber / ial@ \u2026\uFF09\uFF0C\n * \u6BD4\u6A2A\u5411\u6EDA\u52A8\u96BE\u8BFB\u5F97\u591A\u3002\u5B81\u53EF\u8BA9\u8FD9\u7C7B\u5217\u6491\u5230 9em \u5BBD\u3001\u5FC5\u8981\u65F6\u6574\u8868\u6A2A\u5411\u6EDA\u52A8\uFF0C\n * \u4E5F\u4E0D\u8981\u6587\u5B57\u7AD6\u6392\u3002\n */\n.chub-scroll td.wide{min-width:9em}\n/* \u77ED\u5185\u5BB9\u5217\u4FDD\u6301\u5355\u884C\uFF08\u65F6\u95F4\u3001\u6570\u5B57\u3001\u72B6\u6001\u3001\u6BD4\u4F8B\uFF09\uFF0C\u65E2\u4E0D\u6362\u884C\u4E5F\u4E0D\u6491\u5BBD\u3002 */\n.chub-scroll td.nowrap,\n.chub-scroll td:has(> code){white-space:nowrap}\n/**\n * \u542B\u53EF\u5C55\u5F00 JSON \u7684\u5355\u5143\u683C\uFF08details\uFF09\uFF1A\u9876\u90E8\u5BF9\u9F50\u5E76\u9650\u5236\u5C55\u5F00\u5BBD\u5EA6\u3002\n *\n * \u26A0\uFE0F **\u4E0D\u80FD\u5199\u6210 td:last-child**\uFF08\u771F\u5B9E\u7F3A\u9677\uFF0C2026-10-21 \u7528\u6237\u62A5\u969C\u300C\u8FD0\u884C\u65E5\u5FD7\n * \u6700\u540E\u4E00\u5217\u5185\u5BB9\u4F1A\u4E0D\u662F\u5782\u76F4\u5C45\u4E2D\u300D\uFF09\uFF1A\u65E7\u300C\u8BE6\u60C5\u300D\u5217\u6B63\u597D\u662F\u6700\u540E\u4E00\u5217\uFF0C\u4E8E\u662F\u8FD9\u6761\u89C4\u5219\n * \u7528\u4F4D\u7F6E\u9009\u4E2D\u4E86\u5B83\u3002\u8BE6\u60C5\u5217\u79FB\u9664\u540E\u6700\u540E\u4E00\u5217\u53D8\u6210\u300C\u7F13\u5B58\u547D\u4E2D\u7387\u300D\uFF0Cvertical-align:top\n * \u5C31\u628A\u5B83\u9876\u5230\u884C\u9996\uFF0C\u4E0E\u540C\u6392\u5176\u5B83\u5C45\u4E2D\u7684\u5355\u5143\u683C\u9519\u4F4D\u3002\n * \u6545\u6539\u4E3A\u6309**\u5185\u5BB9**\u9009\u4E2D\uFF1A\u53EA\u6709\u771F\u7684\u5E26 details \u7684\u683C\u5B50\u624D\u9876\u90E8\u5BF9\u9F50\u3002\n */\n.chub-scroll td:has(details){vertical-align:top}\n.chub-scroll td details{max-width:260px}\n.chub-scroll td .chub-pre{max-width:260px}\n.chub-scroll td summary{white-space:nowrap}\n.chub-scroll tbody tr:first-child td{border-top:0}\n.chub-scroll tbody tr:hover td{background:color-mix(in srgb,var(--chub-layer-2) 52%,transparent)}\n.chub-scroll code{padding:1px 4px;border-radius:4px;background:var(--chub-layer-2);font-size:11.5px}\n/**\n * \u7A84\u5BB9\u5668\u4E0B\u4E22\u5F03**\u6B21\u8981\u5217**\uFF0C\u800C\u4E0D\u662F\u7559\u4E00\u6761\u6A2A\u5411\u6EDA\u52A8\u6761\u3002\n *\n * \u26A0\uFE0F \u8FD9\u4E9B\u5217\uFF08\u6B65\u6570\u3001\u7F13\u5B58\u8BFB/\u5199\u3001\u601D\u8003\uFF09\u5728\u5BBD\u5C4F\u4E0B\u6709\u4FE1\u606F\u91CF\uFF0C\u4F46\u5B83\u4EEC\u7684\u503C\u90FD\u80FD\u5728\n * \u300C\u8BE6\u60C5\u300D\u5C55\u5F00\u7684\u539F\u59CB attempts JSON \u91CC\u67E5\u5230\uFF08\u6B65\u6570\u8FD8\u76F4\u63A5\u5199\u5728\u8BE6\u60C5\u6458\u8981\u91CC\uFF09\u3002\n * \u5BB9\u5668\u4E0D\u591F\u5BBD\u65F6\u4F18\u5148\u4FDD\u4F4F\u65F6\u95F4\u3001\u6E20\u9053\u3001\u7ED3\u679C\u3001\u8D26\u53F7\u3001\u8017\u65F6\u3001\u901F\u5EA6\u8FD9\u4E9B\u4E3B\u5217 \u2014\u2014\n * \u8BA9\u7528\u6237\u6A2A\u5411\u62D6\u52A8\u53BB\u770B\u4E00\u773C\u6B65\u6570\uFF0C\u6BD4\u5C11\u663E\u793A\u4E00\u5217\u66F4\u70E6\u4EBA\u3002\n */\n@container chub (max-width:1400px){\n  .chub-scroll th.lowpri,.chub-scroll td.lowpri{display:none}\n}\n.chub-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;padding:22px 16px;border:1px dashed var(--chub-line);border-radius:11px;background:color-mix(in srgb,var(--chub-layer-1) 62%,transparent);text-align:center}\n/**\n * \u6E20\u9053\u5361\u91CC\u7684\u7A7A\u72B6\u6001\uFF08\u300C\u5C1A\u672A\u6DFB\u52A0\u8D26\u53F7\u300D\uFF09\u5403\u6389\u5361\u7247\u5269\u4F59\u9AD8\u5EA6\u3002\n *\n * \u26A0\uFE0F \u5361\u7247\u884C\u5185\u7B49\u9AD8\u4E4B\u540E\uFF0C0 \u8D26\u53F7\u7684\u5361\u4F1A\u88AB\u62C9\u5230\u4E0E\u90BB\u5361\u540C\u9AD8\uFF1B\u82E5\u7A7A\u72B6\u6001\u4E0D\u4F38\u5C55\uFF0C\n * \u591A\u51FA\u6765\u7684\u9AD8\u5EA6\u5C31\u53D8\u6210\u865A\u7EBF\u6846\u4E0B\u9762\u7684\u4E00\u5927\u7247\u767D \u2014\u2014 \u6BD4\u539F\u6765\u7684\u6D1E\u66F4\u96BE\u770B\u3002\u8BA9\u5B83 `flex:1`\n * \u5E76\u4FDD\u6301\u5C45\u4E2D\uFF0C\u5361\u7247\u624D\u662F\u4E00\u5F20\u5B8C\u6574\u7684\u5361\u3002\n */\n.chub-channel>.chub-empty{flex:1 1 auto;justify-content:center}\n.chub-empty b{font-size:13.5px;font-weight:640}\n.chub-empty p{margin:0;font-size:12.5px;line-height:1.55;color:var(--chub-text-3)}\n.chub-pager{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:12.5px;color:var(--chub-text-3)}\n.chub-pager>div{display:flex;align-items:center;gap:5px}\n.chub-pager b{font-weight:650;color:var(--chub-text-2);font-variant-numeric:tabular-nums}\n.chub-logpanel{padding:0;overflow:hidden}\n/**\n * \u8FD0\u884C\u65E5\u5FD7\uFF1A\u8868\u683C**\u81EA\u5DF1\u7EB5\u5411\u6EDA\u52A8**\uFF0C\u6A2A\u5411\u6EDA\u52A8\u6761\u56E0\u6B64\u56FA\u5B9A\u5728\u5B83\u7684\u5E95\u8FB9\u5E38\u9A7B\u53EF\u89C1\u3002\n *\n * \u26A0\uFE0F \u771F\u5B9E\u8BC9\u6C42\uFF082026-10-21\uFF0C\u7528\u6237\u5E26\u4FA7\u680F\u3001\u7A97\u53E3\u66F4\u7A84\uFF09\uFF1A\u65E5\u5FD7\u8868\u5728\u7A84\u7A97\u53E3\u4E0B\u786E\u5B9E\n * \u9700\u8981\u6A2A\u5411\u6EDA\u52A8\uFF0C\u4F46\u6EDA\u52A8\u6761\u753B\u5728**\u8868\u683C\u5BB9\u5668\u7684\u5E95\u8FB9**\u2014\u2014\u82E5\u6574\u4E2A\u65E5\u5FD7\u533A\u8DDF\u7740\u9875\u9762\u4E00\u8D77\n * \u6EDA\uFF0C\u7528\u6237\u5FC5\u987B\u5148\u6EDA\u5230\u8868\u683C\u6700\u672B\u4E00\u884C\u624D\u770B\u5F97\u89C1\u5B83\uFF0C\u60F3\u5DE6\u53F3\u62D6\u8FD8\u5F97\u6765\u56DE\u6EDA\u3002\n *\n * \u505A\u6CD5\uFF1A\u628A\u8FD9\u4E00\u9875\u7684\u5185\u5BB9\u533A\u53D8\u6210"\u586B\u6EE1\u5269\u4F59\u9AD8\u5EA6"\u7684\u5217\uFF0C\u65E5\u5FD7\u9762\u677F flex:1 \u5360\u636E\n * \u5269\u4F59\u7A7A\u95F4\uFF0C\u8868\u683C\u5BB9\u5668 height:100% \u4E14\u5728\u5185\u90E8 overflow:auto\u3002\u4E8E\u662F\uFF1A\n *  - \u7EB5\u5411\u6EDA\u52A8\u53D1\u751F\u5728\u8868\u683C\u5BB9\u5668\u5185\u90E8\uFF08\u8868\u5934 sticky \u4ECD\u7136\u6709\u6548\uFF09\uFF1B\n *  - \u6A2A\u5411\u6EDA\u52A8\u6761\u6C38\u8FDC\u8D34\u5728\u5BB9\u5668\u5E95\u8FB9\uFF0C\u4E0D\u9700\u8981\u5148\u6EDA\u5230\u5E95\u3002\n *\n * \u26A0\uFE0F \u4E0D\u80FD\u53EA\u7ED9\u5BB9\u5668 max-height\uFF1A\u90A3\u4F1A\u628A\u65E5\u5FD7\u8868\u538B\u6210\u56FA\u5B9A\u9AD8\u5EA6\u7684\u5C0F\u7A97\u53E3\uFF0C\n * \u77ED\u5217\u8868\u4E5F\u4F1A\u7559\u4E00\u7247\u7A7A\u767D\u3002flex:1 + min-height:0 \u624D\u662F"\u7528\u4E86\u591A\u5C11\u5360\u591A\u5C11\u3001\n * \u5269\u4F59\u9AD8\u5EA6\u5168\u7ED9\u8868\u683C"\u3002\n */\n.chub-logs,.chub-logs>.chub-section{display:flex;flex-direction:column;min-height:0}\n.chub-logs{flex:1 1 auto;overflow:hidden}\n.chub-logs>.chub-section{flex:1 1 auto}\n.chub-logs .chub-sectionhead,.chub-logs .chub-pager{flex:none}\n.chub-logs .chub-logpanel{flex:1 1 auto;min-height:0}\n.chub-logs .chub-logpanel>.chub-scroll{height:100%;min-height:0;overflow:auto}\n/**\n * \u6EDA\u52A8\u6761**\u59CB\u7EC8\u53EF\u89C1**\uFF0C\u4E14\u5BBD\u5EA6\u660E\u786E\u3002\n *\n * \u26A0\uFE0F Chromium \u5728 Windows \u4E0A\u9ED8\u8BA4\u7528**\u8986\u76D6\u5F0F\u6EDA\u52A8\u6761**\uFF08overlay\uFF09\uFF1A\u4E0D\u6EDA\u52A8\u65F6\u6DE1\u51FA\uFF0C\n * \u4E14\u7EC6\u5230\u4E0D\u6613\u6293\u53D6\u3002\u7528\u6237\u660E\u786E\u8981\u6C42\u300C\u51FA\u73B0\u6A2A\u5411\u6EDA\u52A8\u6761\u65F6\u4E00\u76F4\u53EF\u89C1\u4EE5\u4FBF\u62D6\u52A8\u300D\uFF0C\u6545\uFF1A\n *  - scrollbar-width:auto\uFF08\u4E0D\u7528 thin\uFF0C\u5426\u5219\u66F4\u96BE\u6293\uFF09\n *  - \u663E\u5F0F\u7ED9 webkit \u6EDA\u52A8\u6761\u5C3A\u5BF8\u4E0E\u6ED1\u5757\u989C\u8272\uFF0C\u907F\u514D"\u770B\u4E0D\u89C1\u5C31\u6CA1\u6CD5\u62D6"\n *  - overflow-x:auto \u800C\u4E0D\u662F overlay\uFF0C\u903C\u51FA\u5360\u4F4D\u5F0F\u6EDA\u52A8\u6761\n *\n * \u26A0\uFE0F \u4E0D\u8981\u628A webkit \u6EDA\u52A8\u6761\u8BBE\u6210 display:none \u2014\u2014 \u90A3\u4F1A\u5F7B\u5E95\u6D88\u706D\u62D6\u52A8\u6761\uFF0C\n * \u53EA\u80FD\u9760\u89E6\u63A7\u677F\u6A2A\u5411\u6ED1\uFF0C\u9F20\u6807\u7528\u6237\u5C31\u6CA1\u6709\u51FA\u8DEF\u4E86\u3002\n */\n.chub-scroll{scrollbar-width:auto;scrollbar-color:color-mix(in srgb,var(--chub-text-3) 62%,transparent) transparent}\n.chub-scroll::-webkit-scrollbar{width:11px;height:11px}\n.chub-scroll::-webkit-scrollbar-track{background:color-mix(in srgb,var(--chub-layer-2) 70%,transparent);border-radius:6px}\n.chub-scroll::-webkit-scrollbar-thumb{border:2px solid transparent;border-radius:6px;background-clip:content-box;background-color:color-mix(in srgb,var(--chub-text-3) 55%,transparent)}\n.chub-scroll::-webkit-scrollbar-thumb:hover{background-color:color-mix(in srgb,var(--chub-text-3) 78%,transparent)}\n.chub-scroll::-webkit-scrollbar-corner{background:transparent}\n.chub-migration{gap:9px}\n.chub-panelacts{display:flex;align-items:center;gap:6px;flex-wrap:wrap}\n@keyframes chub-in{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}\n@media (hover:hover){\n  .chub-channel:hover{transform:translateY(-2px);border-color:color-mix(in srgb,var(--chan-accent) 30%,var(--chub-line));box-shadow:0 12px 28px color-mix(in srgb,#000 10%,transparent)}\n}\n/**\n * \u65AD\u70B9\u7528**\u5BB9\u5668\u67E5\u8BE2**\u800C\u4E0D\u662F\u89C6\u53E3\u5BBD\u5EA6\u3002\n *\n * \u26A0\uFE0F \u8FD9\u662F\u4ECE\u8BBE\u7F6E\u9875\u8FC1\u5230\u6574\u7A97\u9762\u677F\u65F6\u66B4\u9732\u7684\u771F\u5B9E\u95EE\u9898\uFF1A\u65E7\u65AD\u70B9\u6309**\u89C6\u53E3\u5BBD\u5EA6**\u5224\u5206\u680F\uFF0C\n * \u800C\u8BBE\u7F6E\u9875\u91CC\u89C6\u53E3\u53EF\u80FD\u6709 1400px\u3001\u5B9E\u9645\u5185\u5BB9\u533A\u53EA\u6709\u7EA6 564px \u2014\u2014 \u90A3\u6761\u67E5\u8BE2\u6C38\u8FDC\u4E0D\u547D\u4E2D\uFF0C\n * \u53CC\u680F\u548C 3 \u5217 KPI \u5C31\u5728 564px \u91CC\u786C\u6324\u3002\u5BB9\u5668\u67E5\u8BE2\u8BA9\u300C\u5BBD\u4E86\u5C31\u5206\u680F\u3001\u7A84\u4E86\u5C31\u5355\u5217\u300D\n * \u8DDF\u7740**\u771F\u5B9E\u53EF\u7528\u5BBD\u5EA6**\u8D70\uFF0C\u4E24\u4E2A\u5165\u53E3\uFF08\u6574\u7A97 / \u8BBE\u7F6E\uFF09\u81EA\u52A8\u5404\u5F97\u5176\u6240\uFF0C\u4E0D\u9700\u8981\u4E24\u5957\u89C4\u5219\u3002\n */\n/**\n * \u300C\u4F7F\u7528\u8D26\u53F7\u300D\u4E0B\u62C9\u6846\u3002\n *\n * \u7528\u6237 2026-10-29 \u62A5\u969C\uFF1A\u300C\u4E0B\u62C9\u6846\u6587\u5B57\u8FC7\u957F\u4F1A\u8D85\u51FA\u6324\u538B\u5176\u5B83\u6587\u5B57\u300D\u3002\u5B9E\u6D4B\u5F62\u6001\n * \uFF08\u534E\u4E3A\u7801\u9053\uFF0C\u6635\u79F0 `codearts-d6a47740-cb1d-4ac1-80d4-34f8e0efe974`\uFF0C45 \u5B57\u7B26\uFF09\uFF1A\n * \u7EDF\u8BA1\u884C**\u88AB\u8FEB\u6362\u884C**\uFF0C\u300C\u8D26\u53F7 1/1\u300D\u300C\u6A21\u578B N\u300D\u300C\u76EE\u5F55\u300D\u88AB\u9876\u5230\u4E0B\u4E00\u884C\uFF0C\u5361\u7247\u6BD4\u540C\u6392\n * \u9AD8\u51FA\u4E00\u5927\u622A\uFF1B\u540C\u65F6\u539F\u751F `<select>` \u7684\u9ED8\u8BA4 `text-overflow` \u662F `clip`\uFF0C\u957F\u6635\u79F0\n * \u5728\u5B57\u5F62\u4E2D\u95F4\u88AB\u786C\u5207\uFF08\u672B\u5B57\u7B26\u53EA\u5269\u534A\u4E2A\u5B57\u5F62\uFF09\u3002\n *\n * \u4E09\u6761\u89C4\u5219\u7F3A\u4E00\u4E0D\u53EF\uFF1A\n *\n * 1. **\u6574\u884C\u4E0D\u6362\u884C**\uFF08`.chub-chanmeta{flex-wrap:nowrap}`\uFF09\u2014\u2014 \u6362\u884C\u662F\u300C\u6324\u538B\u300D\n *    \u7684\u5B9E\u9645\u673A\u5236\uFF1A\u4E0D\u662F\u6587\u5B57\u88AB\u538B\u6241\uFF0C\u800C\u662F\u6574\u7EC4\u8BFB\u6570\u88AB\u63A8\u8D70\u3002\n * 2. **\u53EA\u6709\u4E0B\u62C9\u6846\u8BA9\u6B65**\uFF08`flex:0 1 auto` + `min-width`\uFF09\u2014\u2014 \u8BFB\u6570\u9879 `flex:none`\n *    \u662F\u4E0D\u53EF\u534F\u5546\u7684\uFF0C\u5426\u5219\u5B83\u4EEC\u4F1A\u88AB\u538B\u7F29/\u6298\u53E0\u5230\u770B\u4E0D\u6E05\u3002\n * 3. **\u7701\u7565\u53F7**\uFF08`text-overflow:ellipsis` + `overflow:hidden` + `nowrap`\uFF09\u2014\u2014\n *    Chromium \u786E\u5B9E\u5BF9\u539F\u751F select \u751F\u6548\uFF08`artifacts/harness/probe-select-ellipsis.mjs`\n *    \u5B9E\u6D4B\u6E32\u67D3\u6210 `codearts-6e3c\u2026`\uFF09\u3002`max-width` \u7528 `min(\u5BBD, 100%)`\uFF1A\u5361\u7247\u672C\u8EAB\n *    \u7A84\u4E8E\u5B9A\u503C\u65F6\u9000\u56DE\u5BB9\u5668\u5BBD\uFF0C\u7EDD\u4E0D\u6EA2\u51FA\u3002\n *\n * \u26A0\uFE0F \u539F\u5148\u8FD9\u91CC\u8FD8\u6709\u4E00\u6761 `flex-wrap:wrap` + \u4E00\u884C\u300C\u56FA\u5B9A\u4F7F\u7528\uFF0C\u4E0D\u81EA\u52A8\u6362\u53F7\u300D\u7684\u63D0\u793A\n * \u6587\u5B57\u3002\u90A3\u884C\u63D0\u793A\u662F**\u653E\u4E0D\u4E0B**\u7684\u4E3B\u4F53\uFF1A\u5E26\u5B83\u65F6\u4E00\u884C\u9700\u8981 658px\uFF0C\u800C\u5361\u7247\u5185\u5BB9\u5BBD\u6700\u5BBD\n * \u4E5F\u53EA\u6709 442px\uFF082400px \u89C6\u53E3\u5B9E\u6D4B\uFF09\uFF0C\u4E8E\u662F\u5B83\u628A\u6574\u7EC4\u8BFB\u6570\u9876\u5230\u4E0B\u4E00\u884C\u3002\u5DF2\u4ECE\u6807\u8BB0\u91CC\n * \u79FB\u9664\uFF0C\u5176\u542B\u4E49\u5E76\u5165\u4E0B\u62C9\u6846\u7684 `title`\uFF08\u89C1 client.ts \u7684 `selectedOptionTitle`\uFF09\u3002\n */\n.chub-account-choice{display:flex;align-items:center;gap:7px;min-width:0;max-width:100%;flex-wrap:nowrap;flex:0 1 auto}\n.chub-account-choice>span{flex:none}\n.chub-account-choice select{\n  flex:0 1 auto;\n  min-width:76px;\n  max-width:min(200px,100%);\n  font:inherit;\n  padding:4px 8px;\n  border:1px solid var(--chub-line);\n  border-radius:7px;\n  background:var(--chub-layer-1);\n  color:inherit;\n  overflow:hidden;\n  text-overflow:ellipsis;\n  white-space:nowrap;\n}\n.chub{container-type:inline-size;container-name:chub}\n/**\n * \u7A84\u5361\u7247\u515C\u5E95\uFF1A\u7EDF\u8BA1\u884C\u7684\u8BFB\u6570\u9879\u672C\u8EAB\u4E0D\u53EF\u538B\u7F29\uFF0C\u5361\u7247\u7A84\u5230\u4E00\u5B9A\u7A0B\u5EA6\u65F6\uFF08\u5355\u5217 380px\n * \u5361\u7247\u5B9E\u6D4B\u4ECD\u591F\u7528\uFF0C\u8FD9\u91CC\u53EA\u7559\u7ED9\u66F4\u7A84\u7684\u5BB9\u5668\uFF09\u5141\u8BB8\u6574\u7EC4\u8BFB\u6570**\u6362\u884C** \u2014\u2014 \u6362\u884C\u867D\u7136\n * \u96BE\u770B\uFF0C\u4F46\u6BD4\u8BA9\u300C\u8D26\u53F7 N/M\u300D\u88AB\u538B\u6210\u7AD6\u6392\u6216\u6EA2\u51FA\u5361\u7247\u5F3A\u3002\u4E0B\u62C9\u6846\u5728\u4EFB\u4F55\u5BBD\u5EA6\u4E0B\u90FD\n * \u5148\u8BA9\u4F4D\uFF08\u89C1 `.chub-account-choice`\uFF09\uFF0C\u6240\u4EE5\u8FD9\u6761\u5206\u652F\u5F88\u5C11\u771F\u7684\u547D\u4E2D\u3002\n */\n@container chub (max-width:420px){\n  .chub-chanmeta{flex-wrap:wrap}\n}\n@container chub (max-width:820px){\n  .chub-channels{grid-template-columns:1fr}\n  /**\n   * \u26A0\uFE0F \u5355\u5217\u65F6**\u5FC5\u987B**\u6536\u56DE\u8DE8\u5217\u3002\n   *\n   * `grid-column:span 2` \u5728\u53EA\u6709 1 \u5217\u7684\u7F51\u683C\u91CC\u4F1A\u51ED\u7A7A\u9020\u51FA**\u9690\u5F0F\u7B2C\u4E8C\u5217**\uFF0C\u4E8E\u662F\n   * \u5361\u7247\u53EA\u5360\u534A\u5BBD\u3001\u53F3\u8FB9\u7559\u4E00\u6761\u4E0E\u5361\u7247\u7B49\u9AD8\u7684\u767D \u2014\u2014 \u6BD4\u539F\u6765\u7684\u6D1E\u66F4\u7CDF\u3002\u5B9E\u6D4B 780px\n   * \u4F1A\u7A33\u5B9A\u590D\u73B0\u3002\u8FD9\u6761\u89C4\u5219\u4E0D\u80FD\u7701\u3002\n   */\n  .chub-channel[data-multi]{grid-column:auto}\n  .chub-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}\n  .chub-hero{padding:18px 18px 16px}\n}\n@container chub (max-width:560px){\n  .chub{gap:13px}\n  .chub h2{font-size:23px}\n  .chub-hero{padding:15px 14px 13px;border-radius:16px}\n  .chub-pagehead{align-items:flex-start}\n  .chub-pills{width:100%;margin-left:0}\n  .chub-pill{flex:1;justify-content:center}\n  .chub-ministats{grid-template-columns:1fr 1fr}\n  .chub-kpis{grid-template-columns:1fr}\n  .chub-navbar{align-items:stretch}\n  .chub-tabs{width:100%}\n  .chub-tabs button{flex:1;padding:6px 8px}\n  .chub-navacts{width:100%;justify-content:space-between}\n  .chub-field,.chub-field.grow{flex:1 1 100%}\n  .chub-channel{padding:13px 13px 11px;border-radius:13px}\n  .chub-panel{padding:12px 12px}\n  .chub-chanstate{display:none}\n}\n/**\n * \u7A84\u7A97\u53E3\u4E0B\u7684\u8865\u5145\u89C4\u5219\u3002\n *\n * \u26A0\uFE0F \u7528 @media \u800C\u4E0D\u662F\u5BB9\u5668\u67E5\u8BE2\uFF1A\u8FD9\u91CC\u8C03\u7684\u662F**\u5BB9\u5668\u81EA\u5DF1\u7684\u5185\u8FB9\u8DDD**\uFF0C\u5C5E\u4E8E\n * \u300C\u7A97\u53E3\u6709\u591A\u7A84\u300D\u7684\u95EE\u9898\uFF1B\u5BB9\u5668\u67E5\u8BE2\u53EA\u80FD\u6539\u5B50\u5B59\u5143\u7D20\uFF0C\u6539\u4E0D\u4E86\u88AB\u67E5\u8BE2\u5BB9\u5668\u81EA\u8EAB\u3002\n */\n@media (max-width:820px){\n  .chub{padding:0 14px 24px}\n}\n@media (prefers-reduced-motion:reduce){\n  .chub *,.chub *::before,.chub *::after{animation-duration:.001ms !important;transition-duration:.001ms !important}\n}\n';

  // src/client.ts
  window.__ModuleLoader__.load({
    id: "dsh-channel-hub",
    factory: (require2) => {
      const React = require2("react");
      const h = React.createElement;
      const { useState, useEffect, useRef } = React;
      const fmt = (n, d = 0) => typeof n === "number" ? n.toLocaleString("zh-CN", { maximumFractionDigits: d }) : "\u2014";
      const pct = (n) => typeof n === "number" ? fmt(n * 100, 1) + "%" : "\u2014";
      function stackHeights(values, barHeight, minHeight) {
        const count = values.length;
        if (count === 0) return [];
        const total = values.reduce((n, v) => n + v, 0);
        if (!(total > 0) || !(barHeight > 0)) return values.map(() => 0);
        if (barHeight <= minHeight * count)
          return values.map(() => barHeight / count);
        const heights = values.map((v) => v / total * barHeight);
        let deficit = 0;
        for (let i = 0; i < count; i++) {
          if (heights[i] < minHeight) {
            deficit += minHeight - heights[i];
            heights[i] = minHeight;
          }
        }
        if (deficit > 0) {
          const room = heights.map(
            (h2, i) => values[i] > 0 && h2 > minHeight ? h2 - minHeight : 0
          );
          const roomTotal = room.reduce((n, v) => n + v, 0);
          if (roomTotal > 0) {
            for (let i = 0; i < count; i++)
              if (room[i] > 0) heights[i] -= room[i] / roomTotal * deficit;
          }
        }
        return heights;
      }
      const date = (n) => n ? new Date(n).toLocaleString("zh-CN") : "\u2014";
      const mark = (name) => String(name ?? "").replace(/[^A-Za-z0-9\u4e00-\u9fff]/g, "").slice(0, 2).toUpperCase() || "?";
      const accents = {
        codearts: "#c05a5a",
        buddy: "#2f7cf6",
        workbuddy: "#2fa58a",
        qoder: "#6b6ef5",
        qodercn: "#4c8fd9",
        trae: "#2fa58a",
        loomy: "#d35d8a",
        raccoon: "#b47a2e",
        gemini: "#4285f4"
      };
      const accentOf = (id) => accents[id] ?? ["#5b8def", "#2fa58a", "#d97757", "#8b6be0", "#3a9bd9", "#c05a5a"][[...id].reduce((n, ch) => n + ch.charCodeAt(0), 0) % 6];
      const accountOptionLabel = (a, accounts) => (a.nickname || a.id) + (a.nickname && accounts.filter((other) => other.nickname === a.nickname).length > 1 ? " \xB7 " + a.id.slice(-6) : "") + (a.enabled ? "" : "\uFF08\u5DF2\u505C\u7528\uFF09");
      const selectedOptionTitle = (c, accounts) => {
        if (!c.selectedAccountId)
          return "\u81EA\u52A8\u9009\u62E9\uFF1A\u8BE5\u6E20\u9053\u6309\u53EF\u7528\u8D26\u53F7\u8F6E\u6362\uFF0C\u4E0D\u4F1A\u56FA\u5B9A\u5230\u67D0\u4E00\u4E2A";
        const account = accounts.find((a) => a.id === c.selectedAccountId);
        if (!account) return "\u6307\u5B9A\u8D26\u53F7\u5DF2\u5220\u9664\uFF0C\u8BF7\u91CD\u65B0\u9009\u62E9";
        return accountOptionLabel(account, accounts) + "\n\u56FA\u5B9A\u4F7F\u7528\uFF0C\u4E0D\u81EA\u52A8\u6362\u53F7";
      };
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
      function packChannels(list, columns) {
        if (columns <= 1 || list.length <= 1) return list;
        const wide = list.filter((c) => (c.accounts?.length ?? 0) > 1);
        if (wide.length === 0) return list;
        const narrow = list.filter((c) => (c.accounts?.length ?? 0) <= 1);
        const perWide = Math.max(0, columns - 2);
        const out = [];
        let cursor = 0;
        for (const card of wide) {
          out.push(card);
          for (let i = 0; i < perWide && cursor < narrow.length; i++)
            out.push(narrow[cursor++]);
        }
        while (cursor < narrow.length) out.push(narrow[cursor++]);
        return out;
      }
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
        const [refreshing, setRefreshing] = useState(false);
        const [notice, setNotice] = useState("");
        const [authorization, setAuthorization] = useState(null);
        const [importRows, setImportRows] = useState(null);
        const [smsLogin, setSmsLogin] = useState(null);
        const [gridColumns, setGridColumns] = useState(1);
        const gridRef = useRef(null);
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
        useEffect(() => {
          const element = gridRef.current;
          if (!element) return;
          const measure = () => {
            const value = getComputedStyle(element).gridTemplateColumns;
            const tracks = value.trim().split(/\s+/).filter(Boolean).length;
            setGridColumns((current) => {
              const next = tracks > 0 ? tracks : 1;
              return current === next ? current : next;
            });
          };
          measure();
          let frame = 0;
          if (typeof requestAnimationFrame === "function")
            frame = requestAnimationFrame(measure);
          if (typeof ResizeObserver === "undefined") return () => {
            if (frame) cancelAnimationFrame(frame);
          };
          const observer = new ResizeObserver(measure);
          observer.observe(element);
          return () => {
            if (frame) cancelAnimationFrame(frame);
            observer.disconnect();
          };
        }, []);
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
        const refreshAllModels = async () => {
          if (refreshing || channels.length === 0) return;
          setRefreshing(true);
          setError("");
          setNotice("");
          try {
            const result = await rpc("models.refresh", {});
            const failures = Array.isArray(result?.failures) ? result.failures : [];
            const skipped = Array.isArray(result?.skipped) ? result.skipped : [];
            const refreshed = Number(result?.refreshed ?? 0);
            const total = Number(result?.total ?? channels.length);
            const channelName = (id) => channels.find((c) => c.id === id)?.name ?? id;
            await load();
            if (refreshed === 0 && failures.length === 0)
              setNotice(
                "\u6CA1\u6709\u53EF\u66F4\u65B0\u7684\u6E20\u9053\uFF1A\u5DF2\u6DFB\u52A0\u8D26\u53F7\u7684\u6E20\u9053\u4E3A 0" + (skipped.length ? "\uFF08" + skipped.map(channelName).join("\u3001") + " \u8FD8\u6CA1\u6709\u8D26\u53F7\uFF09" : "") + "\u3002"
              );
            else {
              const parts = ["\u5DF2\u66F4\u65B0 " + refreshed + "/" + total + " \u4E2A\u6E20\u9053"];
              if (skipped.length)
                parts.push("\u8DF3\u8FC7 " + skipped.length + " \u4E2A\uFF08\u6CA1\u6709\u8D26\u53F7\uFF09");
              if (failures.length) {
                parts.push("\u5931\u8D25 " + failures.length + " \u4E2A");
                setError(parts.join("\uFF1B") + "\uFF1A" + failures.join("\uFF1B"));
              } else setNotice(parts.join("\uFF1B") + "\u3002");
            }
          } catch (e) {
            setError(String(e));
          } finally {
            setRefreshing(false);
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
        const table = (heads, rows, wide = [], low) => {
          const last = heads.length - 1;
          return h(
            "div",
            { className: "chub-scroll" },
            h(
              "table",
              null,
              h(
                "thead",
                null,
                h(
                  "tr",
                  null,
                  ...heads.map(
                    (x, j) => h(
                      "th",
                      {
                        key: x,
                        ...low === void 0 || !low.includes(j) ? {} : { className: "lowpri" }
                      },
                      x
                    )
                  )
                )
              ),
              h(
                "tbody",
                null,
                ...rows.map(
                  (row, i) => h(
                    "tr",
                    { key: i },
                    ...row.map((v, j) => {
                      const classes = [
                        ...low !== void 0 && low.includes(j) ? ["lowpri"] : [],
                        ...j === last ? [] : wide.includes(j) ? ["wide"] : ["nowrap"]
                      ];
                      return h(
                        "td",
                        {
                          key: j,
                          ...classes.length === 0 ? {} : { className: classes.join(" ") }
                        },
                        v
                      );
                    })
                  )
                )
              )
            )
          );
        };
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
            "\u7F13\u5B58\u8BFB / \u5199",
            "\u601D\u8003",
            "\u7F13\u5B58\u547D\u4E2D\u7387"
          ],
          items.map((r) => {
            const a = r.attempts?.at(-1), m = r.metrics;
            const failure = r.error ?? a?.error;
            return [
              date(r.started),
              r.provider + " / " + r.model,
              h(
                "span",
                {
                  className: "chub-badge " + (r.outcome === "success" ? "ok" : r.outcome === "running" || r.outcome === "cancelled" ? "warn" : "err"),
                  // 详情列移除后，错误原因靠这里悬停可见。
                  ...failure === void 0 || failure === "" ? {} : { title: failure }
                },
                r.outcome
              ),
              a?.accountName ?? a?.accountId ?? "\u2014",
              r.ended ? fmt(r.ended - r.started) + " ms" : "\u8FD0\u884C\u4E2D",
              r.stepCount ?? 1,
              m?.avgTtftMs !== null ? fmt(m?.avgTtftMs) + " ms" : "\u2014",
              m?.avgTps !== null ? fmt(m?.avgTps, 1) + " tok/s" : "\u2014",
              m?.avgThroughput !== null ? fmt(m?.avgThroughput, 1) + " tok/s" : "\u2014",
              // ⚠️ 「输入 / 输出」列已移除（用户 2026-10-21）：
              // 那一列的数值在数据看板按渠道 / 模型汇总时更可读，日志表里
              // 每行都重复一遍既占宽又不便横向对比。token 总量仍在看板与
              // 概览小指标里。
              (m?.cacheSamples ? fmt(m.cacheRead) : "\u2014") + " / " + (m?.cacheWriteSamples ? fmt(m.cacheWrite) : "\u2014"),
              m?.reasoningSamples ? fmt(m.reasoning) : "\u2014",
              pct(m?.cacheHitRate)
            ];
          }),
          // 只有「渠道 / 模型」(1) 与「账号」(3) 可能很长，允许折行；
          // 其余是时间、毫秒、tok/s、token 数这类短内容，保持单行。
          [1, 3],
          /*
           * 窄容器下牺牲的两列：缓存读/写 (9) 与思考 (10)。
           *
           * ⚠️ 下标随列数变化 —— 移除「输入 / 输出」后这两列各前移一位。
           * 写死旧下标会把别的列误藏（上一轮就出现过位置错位的教训）。
           */
          [9, 10]
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
        const orderedChannels = packChannels(channels, gridColumns);
        const series = stats?.series ?? [];
        const dailyByProvider = Array.isArray(stats?.dailyByProvider) ? stats.dailyByProvider : [];
        const providerTotals = /* @__PURE__ */ new Map();
        for (const row of dailyByProvider)
          providerTotals.set(
            String(row.provider),
            (providerTotals.get(String(row.provider)) ?? 0) + (typeof row.totalTokens === "number" ? row.totalTokens : 0)
          );
        const dailyProviders = [...providerTotals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([provider]) => provider);
        const dailyTotalTokens = [...providerTotals.values()].reduce(
          (n, v) => n + v,
          0
        );
        const segmentColors = [
          "#5785dd",
          "#2f9e6b",
          "#d6922f",
          "#b47a2e",
          "#d97757",
          "#8b6be0",
          "#4c8fd9",
          "#2fa58a",
          "#d35d8a",
          "#6b6ef5",
          "#c05a5a",
          "#3a9bd9"
        ];
        const colorOfProvider = (provider) => {
          const index = dailyProviders.indexOf(provider);
          return segmentColors[(index < 0 ? 0 : index) % segmentColors.length];
        };
        const daySegments = (dayId) => dailyByProvider.filter((row) => String(row.day) === dayId).map((row) => ({
          provider: String(row.provider),
          tokens: typeof row.totalTokens === "number" ? row.totalTokens : 0
        })).filter((segment) => segment.tokens > 0);
        const maxTokens = Math.max(
          1,
          ...series.map(
            (d) => typeof d.totalTokens === "number" ? d.totalTokens : 0
          )
        );
        return h(
          "main",
          // 铺满宿主主区域并自带纵向滚动（见 `.chub` 的 `height:100%` 与
          // `overflow-y:auto`）。这里不再有第二种布局形态。
          { className: "chub" },
          h("style", null, client_default),
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
          notice && h(
            "div",
            { className: "chub-alert info", role: "status" },
            h("p", null, notice)
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
                  /**
                   * 渠道级「更新模型」已上移到这里并**改为更新全部渠道**：
                   * 目录属于渠道而不是某一张卡，逐卡点一次等于重复劳动。
                   *
                   * ⚠️ 与「旧账号导入」同为默认款式（非 `ghost`）：两者并排，
                   * 一个描边一个无描边会看起来像是层级不同的两类操作。
                   */
                  btn(
                    refreshing ? "\u66F4\u65B0\u4E2D\u2026" : "\u66F4\u65B0\u6A21\u578B",
                    refreshAllModels,
                    {
                      small: true,
                      disabled: refreshing || channels.length === 0,
                      title: "\u62C9\u53D6\u5168\u90E8\u6E20\u9053\u7684\u52A8\u6001\u6A21\u578B\u76EE\u5F55\uFF08\u5355\u4E2A\u6E20\u9053\u5931\u8D25\u4E0D\u5F71\u54CD\u5176\u4F59\uFF09"
                    }
                  ),
                  btn(
                    "\u65E7\u8D26\u53F7\u5BFC\u5165",
                    async () => setImportRows(await action("migration.preview")),
                    { small: true }
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
                  ]),
                  // 「来源」与「账号」可能是长路径/长昵称。
                  [0, 1]
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
                { className: "chub-channels", ref: gridRef },
                ...orderedChannels.map((c) => {
                  const accounts = c.accounts ?? [];
                  const catalogModels = /* @__PURE__ */ new Set();
                  for (const a of accounts.filter(
                    (a2) => a2.enabled && (!c.selectedAccountId || a2.id === c.selectedAccountId)
                  ))
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
                      /**
                       * 2 个以上账号的卡片跨两列（样式见 client.css 的
                       * `.chub-channel[data-multi]`）。
                       *
                       * 账号块是纵向列表，多一个账号就多一整块，于是「双账号
                       * 卡」比「单账号卡」高约 200px；网格按行对齐，同排的
                       * 单账号卡下面就是一块死白（1440px 实测 634px）。跨列后
                       * 账号在卡内并排，高度差被宽度吸收。
                       *
                       * ⚠️ 用显式属性而不是让 CSS 写 `:has(.chub-acct +
                       * .chub-acct)`：那会把布局分支绑在标记结构上 —— 账号
                       * 列表里插入任何兄弟元素（错误提示、分组标题、滚动容器）
                       * 都会让 `+` 失效，卡片静默退回单列。
                       */
                      "data-multi": accounts.length > 1 ? "" : void 0,
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
                      /**
                       * 卡片头右端：操作按钮 + 状态徽标，**同一个可换行整体**。
                       *
                       * 用户 2026-10-29：「添加账号」放在「运行中 / 未接入」的
                       * **左侧**。两枚元素必须同组，否则窄卡片里会出现「按钮留在
                       * 第一行、徽标被挤到第二行」—— 视觉上它俩就不挨着了，而
                       * 「动作紧挨结论」正是这次要的效果。
                       *
                       * 顺序是 DOM 顺序（标题 → 操作 → 状态），不用 `order`
                       * 反转：视觉顺序必须等于 Tab 焦点顺序。
                       */
                      h(
                        "div",
                        { className: "chub-chanheadend" },
                        h(
                          "div",
                          { className: "chub-chanacts chub-chanheadacts" },
                          c.id === "loomy" ? h(
                            React.Fragment,
                            null,
                            btn(
                              "\u5FAE\u4FE1\u626B\u7801\u767B\u5F55",
                              () => login(c.id, "wechat"),
                              {
                                kind: "primary",
                                small: true,
                                disabled: busy || !!c.error || c.canLogin === false
                              }
                            ),
                            btn("\u77ED\u4FE1\u767B\u5F55", () => login(c.id, "sms"), {
                              small: true,
                              disabled: busy || !!c.error || c.canLogin === false
                            })
                          ) : btn("\u6DFB\u52A0\u8D26\u53F7", () => login(c.id), {
                            kind: "primary",
                            small: true,
                            disabled: busy || !!c.error || c.canLogin === false
                          })
                        ),
                        h(
                          "span",
                          { className: "chub-chanstate" },
                          c.error ? "\u6E20\u9053\u5F02\u5E38" : accounts.length === 0 ? "\u672A\u63A5\u5165" : accounts.some((a) => a.enabled) ? "\u8FD0\u884C\u4E2D" : "\u5DF2\u505C\u7528"
                        )
                      )
                    ),
                    c.error && h("p", { className: "chub-inline err" }, c.error),
                    /**
                     * 统计行只剩读数：账号 / 模型 / 目录 / 大窗口档开关。
                     *
                     * 按钮组（添加账号、更新模型）已分别迁走 —— 「添加账号」
                     * 进卡片头（贴状态徽标左侧），「更新模型」上移到区块工具条
                     * 并改为更新全部渠道。统计行因此不需要右推留白。
                     */
                    h(
                      "div",
                      { className: "chub-chanmeta" },
                      h(
                        "label",
                        { className: "chub-account-choice" },
                        h("span", null, "\u4F7F\u7528\u8D26\u53F7"),
                        h(
                          "select",
                          {
                            "aria-label": c.name + " \u4F7F\u7528\u8D26\u53F7",
                            value: c.selectedAccountId ?? "",
                            disabled: busy,
                            /**
                             * `title` 放**选中项全文**：下拉框用 `text-overflow:
                             * ellipsis` 把长昵称收成 `…`（否则原生 select 会在
                             * 字形中间硬切，见 client.css 的说明），全文因此只能
                             * 靠悬停补回。未选中（自动选择）时不加，避免出现一个
                             * 与界面文字重复的空悬停。
                             */
                            title: selectedOptionTitle(c, accounts),
                            onChange: (e) => action("channels.selectAccount", {
                              provider: c.id,
                              accountId: e.target.value || null
                            })
                          },
                          h("option", { value: "" }, "\u81EA\u52A8\u9009\u62E9"),
                          c.selectedAccountId && !accounts.some(
                            (a) => a.id === c.selectedAccountId
                          ) && h(
                            "option",
                            { value: c.selectedAccountId, disabled: true },
                            "\u6307\u5B9A\u8D26\u53F7\u5DF2\u5220\u9664\uFF0C\u8BF7\u91CD\u65B0\u9009\u62E9"
                          ),
                          ...accounts.map(
                            (a) => h(
                              "option",
                              {
                                key: a.id,
                                value: a.id,
                                disabled: !a.enabled
                              },
                              accountOptionLabel(a, accounts)
                            )
                          )
                        )
                        /**
                         * 「固定使用，不自动换号」**移除**（2026-10-29）。
                         *
                         * 它原本挂在选中账号旁边解释「你不会被自动换号」。实测
                         * 这句话在卡片网格里**永远放不下**：华为码道这种 45 字符
                         * 昵称的卡片，连同提示语一行需要 658px，而卡片内容宽最宽
                         * 也只有 442px（2400px 视口）。放不下的结果不是它自己被
                         * 截断，而是把「账号 N/M」「模型 N」「目录」整组顶到下一行，
                         * 卡片比同排高出一大截 —— 用户报的「下拉框文字挤压其它
                         * 文字」正是这个。
                         *
                         * 信息也没有丢：下拉框显示着一个具体账号（而不是「自动
                         * 选择」）本身就是「固定使用」的信号，`title` 里还写着
                         * 「指定账号时不会自动换号」。**不要**改成用容器查询把它
                         * 藏起来 —— 两个原因：① 阈值要贴着 658px 这种由昵称长度
                         * 决定的数字，昵称再长一点就重新溢出；② 藏起来的分支永远
                         * 不显示，等于留了一段死代码。
                         */
                      ),
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
                      ),
                      /**
                       * 大窗口档开关（目前只有 Trae 的 Max 1M）。
                       *
                       * ⚠️ **必须显式标注「计费不同」**：目录只下发一个
                       * `consumption_rate`，实测没有 Max 档倍率字段
                       * （`fee_model_level` 恒 2、`is_dollar_max` 恒 null），
                       * 所以界面无法显示「开了之后是几倍」。能说清的只有
                       * 「可能更贵」这一句 —— 不说等于默认替用户选了未知价格。
                       */
                      c.extendedContext?.supported && h(
                        "label",
                        {
                          className: "chub-context-toggle",
                          title: "\u5F00\u542F\u540E\u8BE5\u6E20\u9053\u8D70\u5927\u7A97\u53E3\u6863\uFF08\u5982 Trae \u7684 1M\uFF09\u3002\u4E0A\u6E38\u6309\u53E6\u4E00\u6863\u5355\u72EC\u8BA1\u4EF7\uFF0C\u76EE\u5F55\u4E0D\u4E0B\u53D1\u8BE5\u6863\u500D\u7387 \u2014\u2014 \u663E\u793A\u7684\u662F\u5E38\u89C4\u6863\u500D\u7387\uFF0C\u5B9E\u9645\u6263\u8D39\u53EF\u80FD\u66F4\u9AD8\u3002"
                        },
                        h("input", {
                          type: "checkbox",
                          checked: c.extendedContext.enabled === true,
                          disabled: busy,
                          onChange: (e) => action("channels.setExtendedContext", {
                            provider: c.id,
                            enabled: e.target.checked
                          })
                        }),
                        h("span", null, "\u5927\u7A97\u53E3\u6863")
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
                              "\u76EE\u5F55\u4E3A\u7A7A\u3002\u70B9\u51FB\u4E0A\u65B9\u201C\u66F4\u65B0\u6A21\u578B\u201D\u91CD\u8BD5\uFF0C\u8FDC\u7AEF\u786E\u8BA4\u7684\u6761\u76EE\u4F1A\u81EA\u52A8\u51FA\u73B0\u3002"
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
                                const tier = extendedTierBadge(
                                  m,
                                  c.extendedContext?.enabled === true
                                );
                                const tip = [
                                  m.id,
                                  rate ? "\u8BA1\u8D39\u7CFB\u6570 " + rate : "",
                                  tier ? tier.title : "",
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
                                  ),
                                  tier && h(
                                    "span",
                                    {
                                      className: "chub-tier" + (tier.active ? " on" : ""),
                                      title: tier.title
                                    },
                                    tier.label
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
                      "\u67F1\u5F62\u662F\u6BCF\u5929\u5404\u81EA\u7684\u91CF\uFF1B\u4E0B\u65B9\u56FE\u4F8B\u662F\u8BE5\u533A\u95F4\u7684\u5408\u8BA1\u3002\u60AC\u505C\u53EF\u770B\u5F53\u5929\u4E0E\u5404\u6765\u6E90\u6570\u503C\u3002"
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
                      const width = Math.min(Math.max(1, slot - 2), 36);
                      const x = i * slot + (slot - width) / 2;
                      const segments = daySegments(String(day.id));
                      if (segments.length === 0) {
                        const height = (day.totalTokens || 0) / maxTokens * 108;
                        return h(
                          "rect",
                          {
                            key: day.id,
                            x,
                            y: 118 - height,
                            width,
                            height,
                            rx: 3,
                            className: "chub-bar",
                            fill: "color-mix(in srgb,var(--chub-accent) 68%,transparent)"
                          },
                          h(
                            "title",
                            null,
                            day.id + " \xB7 " + fmt(day.totalTokens) + " Token \xB7 " + fmt(day.requests) + " \u8BF7\u6C42"
                          )
                        );
                      }
                      const sum = segments.reduce(
                        (n, s) => n + s.tokens,
                        0
                      );
                      const barHeight = (day.totalTokens || sum) / maxTokens * 108;
                      const heights = stackHeights(
                        segments.map((s) => s.tokens),
                        barHeight,
                        2
                      );
                      let cursor = 118;
                      return h(
                        "g",
                        { key: day.id },
                        ...segments.map((segment, k) => {
                          const part = heights[k] ?? 0;
                          cursor -= part;
                          const share = sum > 0 ? segment.tokens / sum : 0;
                          return h(
                            "rect",
                            {
                              key: segment.provider,
                              x,
                              y: cursor,
                              width,
                              height: part,
                              // 只有最顶段做圆角，中间段紧贴。
                              rx: k === segments.length - 1 ? 3 : 0,
                              className: "chub-seg",
                              fill: colorOfProvider(segment.provider)
                            },
                            h(
                              "title",
                              null,
                              day.id + " \xB7 " + segment.provider + " \xB7 " + fmt(segment.tokens) + " Token \xB7 \u5360\u5F53\u5929 " + pct(share)
                            )
                          );
                        }),
                        // 整柱的汇总提示挂在透明覆盖层上，悬停空白也能看总量。
                        h(
                          "rect",
                          {
                            x,
                            y: 118 - (day.totalTokens || 0) / maxTokens * 108,
                            width,
                            height: (day.totalTokens || 0) / maxTokens * 108,
                            fill: "transparent"
                          },
                          h(
                            "title",
                            null,
                            day.id + " \xB7 \u5408\u8BA1 " + fmt(day.totalTokens) + " Token \xB7 " + fmt(day.requests) + " \u8BF7\u6C42"
                          )
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
                  ),
                  /*
                   * 图例：渠道 → 色块。
                   *
                   * ⚠️ 只在**真的有分渠道数据**时渲染：没有分渠道
                   * 数据时柱子是单色的，再画一排图例会误导用户以为
                   * 那些渠道都有独立分段。
                   *
                   * ⚠️ 图例数值是**整个筛选区间的合计**，而柱子是
                   * **每日**的量 —— 两者量级天然不同（用户 2026-10-21
                   * 指出过这个困惑）。故在开头显式写一行「合计」，
                   * 并标明「区间合计」，让两套数字各自有明确口径。
                   */
                  dailyProviders.length > 0 && h(
                    "div",
                    { className: "chub-legend" },
                    h(
                      "span",
                      {
                        key: "__total",
                        className: "chub-legendtotal",
                        title: series.length + " \u5929\u7684\u5408\u8BA1\uFF1B\u67F1\u5F62\u662F\u6BCF\u5929\u5404\u81EA\u7684\u91CF"
                      },
                      "\u5408\u8BA1 ",
                      h("b", null, fmt(dailyTotalTokens)),
                      " Token \xB7 ",
                      series.length + " \u5929"
                    ),
                    ...dailyProviders.map((provider) => {
                      const value = providerTotals.get(provider) ?? 0;
                      return h(
                        "span",
                        {
                          key: provider,
                          className: "chub-legenditem",
                          title: provider + " \xB7 \u533A\u95F4\u5185\u5408\u8BA1 " + fmt(value) + " Token" + (dailyTotalTokens > 0 ? " \xB7 \u5360 " + pct(value / dailyTotalTokens) : "")
                        },
                        h("i", {
                          className: "chub-legenddot",
                          style: {
                            background: colorOfProvider(provider)
                          }
                        }),
                        h(
                          "span",
                          { className: "chub-legendname" },
                          provider
                        ),
                        /*
                         * 图例带数值：柱子只有 108px 高，占比小的
                         * 渠道即便保住 2px 可见高度，也读不出具体
                         * 数字；把区间合计写在图例里，精确值就不必
                         * 逐根柱子悬停。
                         */
                        h(
                          "span",
                          { className: "chub-legendvalue" },
                          fmt(value)
                        )
                      );
                    })
                  )
                ),
                series.length > 0 && h(
                  "details",
                  { className: "chub-fold" },
                  h("summary", null, "\u67E5\u770B\u6BCF\u65E5\u660E\u7EC6"),
                  /*
                   * 明细表按**来源分行**：同一日期会出现在多行，
                   * 各自对应一个渠道。这样「哪天是哪家消耗的」在表格里
                   * 也能查到，不只靠柱子的颜色。
                   *
                   * 没有分渠道数据时退回按日期汇总的单行形态。
                   */
                  dailyByProvider.length > 0 ? table(
                    ["\u65E5\u671F", "\u6765\u6E90", "Token", "\u8BF7\u6C42"],
                    dailyByProvider.map((row) => [
                      row.day,
                      row.provider,
                      fmt(row.totalTokens),
                      fmt(row.requests)
                    ]),
                    [1]
                  ) : table(
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
                { className: "chub-stack" },
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
                        "\u6765\u6E90 / \u540D\u79F0",
                        "Token",
                        "\u8BF7\u6C42",
                        "\u6210\u529F\u7387",
                        "\u6D41\u5F0F tok/s",
                        "\u6574\u5757 tok/s",
                        "\u9996\u5B57 ms"
                      ],
                      rows.map((s) => [
                        /*
                         * 「来源 / 名称」两段式。
                         *
                         * ⚠️ `provider` 由宿主**结构化**给出（见
                         * `database.ts` 的 `accountStats` /
                         * `modelGroups`），不要在这里从 `name` 或
                         * `id` 里劈字符串 —— 账号显示名可能是任意
                         * 文本（含 `/`），劈出来的「来源」会错。
                         *
                         * 模型分组本身也改成 `渠道 + 模型` 了：同名模型
                         * 出现在多个渠道时（实测 deepseek-v4.1-flash
                         * 横跨 4 个渠道）不再被合并成一行。
                         */
                        h(
                          "span",
                          { className: "chub-source" },
                          s.provider ?? "\u2014",
                          h("span", { className: "chub-sep" }, " / "),
                          s.name ?? s.id
                        ),
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
            { className: "chub-body chub-logs" },
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
      const PANEL_ID = "channel-hub";
      function ChannelHubIcon(props) {
        const size = typeof props?.size === "number" ? props.size : 18;
        return h(
          "svg",
          {
            width: size,
            height: size,
            viewBox: "0 0 24 24",
            fill: "none",
            stroke: "currentColor",
            strokeWidth: 1.8,
            strokeLinecap: "round",
            strokeLinejoin: "round",
            "aria-hidden": "true",
            focusable: "false"
          },
          // 三个叠放的通道条 + 一条脉冲线：表达「多个渠道 + 真实请求」。
          h("rect", { x: 3, y: 4, width: 18, height: 4.5, rx: 1.5 }),
          h("rect", { x: 3, y: 10.5, width: 11, height: 4.5, rx: 1.5 }),
          h("rect", { x: 3, y: 17, width: 6, height: 3.5, rx: 1.5 }),
          h("path", { d: "M17 12.5l2 2 3-3.5" })
        );
      }
      return {
        name: "channel-hub",
        id: "dsh-channel-hub",
        inject: ["slots", "connection"],
        apply(ctx) {
          ctx.slots.inject(
            "sidebar.panellist",
            () => ctx.slots.register(
              {
                name: "sidebar.panellist",
                id: PANEL_ID,
                order: 35,
                label: () => "\u6E20\u9053\u4E2D\u5FC3"
              },
              ChannelHubIcon
            )
          );
          ctx.slots.inject(
            "main",
            () => ctx.slots.register(
              { name: "main", key: PANEL_ID },
              (props) => h(Page, { ...props, ctx })
            )
          );
        }
      };
    }
  });
})();
