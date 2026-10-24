(function (root) {
  "use strict";

  const zoneId = "content-bottom-ad";
  const nativeAdWebView = /\bAdMobNative\/\d+\b/.test(root.navigator?.userAgent || "");
  let requested = false;
  let failed = false;
  let timeout = 0;
  let currentAd = null;

  function config() { return root.FOODHANNUN_AD_CONFIG || {}; }
  function elements() {
    const zone = root.document.getElementById(zoneId);
    return {zone, host: zone?.querySelector("[data-adfit-host]")};
  }
  function placementForWidth(width) {
    const placements = config().placements || {};
    return width >= 728 ? placements.desktop : placements.mobile;
  }
  function validPlacement(placement) {
    const size = `${Number(placement?.width)}x${Number(placement?.height)}`;
    return /^DAN-[A-Za-z0-9]+$/.test(String(placement?.unit || "").trim())
      && (size === "320x100" || size === "728x90");
  }
  function hide() {
    const {zone, host} = elements();
    root.clearTimeout(timeout);
    failed = true;
    root.document.body?.classList.remove("has-adfit-floating");
    if (zone) zone.hidden = true;
    if (host) host.replaceChildren();
  }
  function load() {
    if (requested || failed || root.document.hidden) return;
    const settings = config();
    const {zone, host} = elements();
    const placement = placementForWidth(host?.clientWidth || 0);
    if (!zone || !host || !settings.enabled || nativeAdWebView || !validPlacement(placement) || host.clientWidth < placement.width) {
      hide();
      return;
    }
    requested = true;
    zone.hidden = false;
    zone.dataset.state = "loading";
    currentAd = root.document.createElement("ins");
    currentAd.className = "kakao_ad_area";
    currentAd.style.display = "none";
    currentAd.dataset.adUnit = placement.unit;
    currentAd.dataset.adWidth = String(placement.width);
    currentAd.dataset.adHeight = String(placement.height);
    currentAd.dataset.adOnfail = "foodhannunAdFitFailed";
    currentAd.dataset.adOnload = "foodhannunAdFitLoaded";
    host.appendChild(currentAd);
    const script = root.document.createElement("script");
    script.async = true;
    script.charset = "utf-8";
    script.src = settings.script || "https://t1.kakaocdn.net/kas/static/ba.min.js";
    script.onerror = hide;
    script.onload = () => {
      timeout = root.setTimeout(() => {
        if (!host.querySelector("iframe")) hide();
      }, 30000);
    };
    root.document.head.appendChild(script);
  }
  function init() {
    const {zone, host} = elements();
    const placement = placementForWidth(host?.clientWidth || 0);
    if (!zone || !host || nativeAdWebView || !config().enabled || !validPlacement(placement)) {
      hide();
      return;
    }
    root.document.body?.classList.add("has-adfit-floating");
    zone.hidden = false;
    if (!root.IntersectionObserver) { load(); return; }
    const observer = new root.IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      load();
    }, {rootMargin: "200px 0px"});
    observer.observe(zone);
  }
  root.foodhannunAdFitFailed = ad => { if (ad === currentAd) hide(); };
  root.foodhannunAdFitLoaded = ad => {
    if (ad !== currentAd || failed) return;
    root.clearTimeout(timeout);
    const {zone} = elements();
    if (zone) zone.dataset.state = "loaded";
  };
  root.addEventListener("DOMContentLoaded", init, {once: true});
})(typeof window === "undefined" ? globalThis : window);
