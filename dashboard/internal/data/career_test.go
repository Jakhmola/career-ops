package data

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseApplicationsUsesTrackerNumberColumn(t *testing.T) {
	tempDir := t.TempDir()
	dataDir := filepath.Join(tempDir, "data")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatalf("failed to create data dir: %v", err)
	}

	applications := `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 140 | 2026-04-16 | Arize AI | AI Engineer, Instrumentation | 4.7/5 | Evaluated | ✅ | [140](reports/140-arize-ai-engineer-instrumentation-2026-04-16.md) | Strong fit |
| 143 | 2026-04-16 | Arize AI | AI Sales Engineer, US | 4.1/5 | Evaluated | ❌ | [143](reports/143-arize-ai-sales-engineer-us-2026-04-16.md) | Good fit |
`

	applicationsPath := filepath.Join(dataDir, "applications.md")
	if err := os.WriteFile(applicationsPath, []byte(applications), 0o644); err != nil {
		t.Fatalf("failed to write applications tracker: %v", err)
	}

	apps := ParseApplications(tempDir)
	if len(apps) != 2 {
		t.Fatalf("expected 2 parsed applications, got %d", len(apps))
	}

	if apps[0].Number != 140 {
		t.Fatalf("expected first application number to be 140, got %d", apps[0].Number)
	}
	if apps[1].Number != 143 {
		t.Fatalf("expected second application number to be 143, got %d", apps[1].Number)
	}
	if apps[0].ReportNumber != "140" || apps[1].ReportNumber != "143" {
		t.Fatalf("expected report numbers to stay aligned with tracker IDs, got %q and %q", apps[0].ReportNumber, apps[1].ReportNumber)
	}
}

// TestParseApplicationsNormalizesReportPaths guards the #760 regression where a
// data/ tracker links reports as "../reports/..." but every dashboard consumer
// joins ReportPath against the repo root — breaking "open report" (enter) and
// the URL enrichment that feeds "open URL" (o). ReportPath must come out
// root-relative and point at a file that exists.
func TestParseApplicationsNormalizesReportPaths(t *testing.T) {
	root := t.TempDir()
	dataDir := filepath.Join(root, "data")
	reportsDir := filepath.Join(root, "reports")
	for _, d := range []string{dataDir, reportsDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", d, err)
		}
	}

	// Two reports on disk; one linked the #760 way ("../reports"), one the legacy
	// root-relative way ("reports") — both must resolve to the same real files.
	reports := map[string]string{
		"401-vapi-2026-06-05.md":      "**URL:** https://example.com/vapi\n",
		"407-channable-2026-06-06.md": "**URL:** https://example.com/channable\n",
	}
	for name, body := range reports {
		if err := os.WriteFile(filepath.Join(reportsDir, name), []byte(body), 0o644); err != nil {
			t.Fatalf("write report %s: %v", name, err)
		}
	}

	applications := `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 407 | 2026-06-06 | Channable | AI Engineer | 4.2/5 | Applied | ✅ | [407](../reports/407-channable-2026-06-06.md) | normalized link |
| 401 | 2026-06-05 | Vapi | Agent Engineer | 2.0/5 | SKIP | ❌ | [401](reports/401-vapi-2026-06-05.md) | legacy link |
`
	if err := os.WriteFile(filepath.Join(dataDir, "applications.md"), []byte(applications), 0o644); err != nil {
		t.Fatalf("write tracker: %v", err)
	}

	apps := ParseApplications(root)
	if len(apps) != 2 {
		t.Fatalf("expected 2 apps, got %d", len(apps))
	}

	want := map[string]string{
		"407": filepath.Join("reports", "407-channable-2026-06-06.md"),
		"401": filepath.Join("reports", "401-vapi-2026-06-05.md"),
	}
	for _, app := range apps {
		exp, ok := want[app.ReportNumber]
		if !ok {
			t.Fatalf("unexpected report number %q", app.ReportNumber)
		}
		if app.ReportPath != exp {
			t.Errorf("report %s: ReportPath = %q, want root-relative %q", app.ReportNumber, app.ReportPath, exp)
		}
		// The whole point: joining against the root must hit a real file.
		if _, err := os.Stat(filepath.Join(root, app.ReportPath)); err != nil {
			t.Errorf("report %s: resolved path does not exist: %v", app.ReportNumber, err)
		}
		// And URL enrichment (strategy 1) must succeed off that readable report.
		if app.JobURL == "" {
			t.Errorf("report %s: JobURL empty — enrichment failed to read the report", app.ReportNumber)
		}
	}
}
