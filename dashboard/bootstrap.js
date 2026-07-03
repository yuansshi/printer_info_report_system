(() => {
  "use strict";

  const cacheKey = Date.now().toString();

  function loadScript(path) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, window.location.href);
      url.searchParams.set("snapshot", cacheKey);

      const script = document.createElement("script");
      script.src = url.href;
      script.addEventListener("load", resolve, { once: true });
      script.addEventListener("error", () => reject(new Error(`Unable to load ${path}`)), { once: true });
      document.head.appendChild(script);
    });
  }

  loadScript("data.js")
    .then(() => loadScript("app.js"))
    .catch((error) => {
      console.error(error);
      document.body.innerHTML = '<div class="empty-state">无法载入最新 Dashboard 数据，请稍后重试。</div>';
    });
})();
