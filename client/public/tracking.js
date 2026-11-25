// Ad conversion tracking for Google Ads and Meta (Facebook/Instagram).
// Nothing loads until the IDs below are filled in. The pickup form calls
// window.lmbTrackLead() after a request is submitted.
(function () {
  var GOOGLE_ADS_ID = "AW-18577554635";
  var GOOGLE_ADS_LEAD_LABEL = "iEviCIusmrkdEMv5u5pF"; // "Pickup request form" conversion
  var META_PIXEL_ID = "2249140882684819";

  window.lmbTrackLead = function () {};

  // Admin pages (/#/admin, /#/inventory, /#/scan, ...) are never tracked.
  if (/^#\/(admin|inventory|scan|supplies|returns|repricer|profit)/.test(location.hash)) return;

  if (GOOGLE_ADS_ID) {
    var gt = document.createElement("script");
    gt.async = true;
    gt.src = "https://www.googletagmanager.com/gtag/js?id=" + GOOGLE_ADS_ID;
    document.head.appendChild(gt);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () {
      window.dataLayer.push(arguments);
    };
    window.gtag("js", new Date());
    window.gtag("config", GOOGLE_ADS_ID);
  }

  if (META_PIXEL_ID) {
    // Meta's standard Pixel loader.
    !(function (f, b, e, v, n, t, s) {
      if (f.fbq) return;
      n = f.fbq = function () {
        n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
      };
      if (!f._fbq) f._fbq = n;
      n.push = n;
      n.loaded = true;
      n.version = "2.0";
      n.queue = [];
      t = b.createElement(e);
      t.async = true;
      t.src = v;
      s = b.getElementsByTagName(e)[0];
      s.parentNode.insertBefore(t, s);
    })(window, document, "script", "https://connect.facebook.net/en_US/fbevents.js");
    window.fbq("init", META_PIXEL_ID);
    window.fbq("track", "PageView");
  }

  window.lmbTrackLead = function () {
    if (GOOGLE_ADS_ID && GOOGLE_ADS_LEAD_LABEL) {
      window.gtag("event", "conversion", { send_to: GOOGLE_ADS_ID + "/" + GOOGLE_ADS_LEAD_LABEL });
    }
    if (META_PIXEL_ID) window.fbq("track", "Lead");
  };
})();
