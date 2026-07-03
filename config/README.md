# Runtime configuration

Place the runtime-only files in this directory for local use:

```text
mail.env
客户名称机身编号映射表.xlsx
```

The Excel compatibility workflow can also use these optional reference files:

```text
对比文件.xlsx
打印机状态-2026-06-20-00001.xlsx
```

`mail.env` uses the same keys as the existing Sina IMAP configuration:

```text
sina_username=account@sina.com
sina_imap_authorization_code=replace-with-runtime-secret
sina_url=https://mail.sina.com.cn/
```

Runtime workbooks and credentials are excluded from Git. Production deployments should store them outside the application checkout and use `PRINTER_ENV_FILE`, `PRINTER_MAPPING_PATH`, `PRINTER_COMPARISON_PATH`, and `PRINTER_REFERENCE_STATUS_PATH` as needed. Daily audit output can be relocated with `PRINTER_DAILY_REPORTS_DIR`; the default is `data/daily_reports/`.
