from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class DashboardAssetTests(unittest.TestCase):
    def test_index_uses_cache_busting_bootstrap(self) -> None:
        index = (ROOT / "dashboard" / "index.html").read_text(encoding="utf-8")
        self.assertIn('src="bootstrap.js"', index)
        self.assertNotIn('src="data.js"', index)
        self.assertNotIn('src="app.js"', index)

    def test_bootstrap_versions_data_and_application_scripts(self) -> None:
        bootstrap = (ROOT / "dashboard" / "bootstrap.js").read_text(encoding="utf-8")
        self.assertIn('url.searchParams.set("snapshot", cacheKey)', bootstrap)
        self.assertIn('loadScript("data.js")', bootstrap)
        self.assertIn('loadScript("app.js")', bootstrap)

    def test_refresh_navigates_to_a_new_document_url(self) -> None:
        application = (ROOT / "dashboard" / "app.js").read_text(encoding="utf-8")
        self.assertIn('url.searchParams.set("refresh", Date.now().toString())', application)
        self.assertIn("window.location.replace(url)", application)

    def test_date_filter_uses_a_plain_all_dates_label(self) -> None:
        application = (ROOT / "dashboard" / "app.js").read_text(encoding="utf-8")
        self.assertIn('<option value="all">全部日期</option>', application)
        self.assertNotIn('DATA.metadata.range.end.slice(5)', application)


if __name__ == "__main__":
    unittest.main()
