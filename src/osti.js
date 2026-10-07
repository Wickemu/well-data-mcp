// DOE geothermal project datasets via the keyless OSTI Data Explorer API, which
// indexes the Geothermal Data Repository (gdr.openei.org).

import { fetchJson } from "./http.js";

const OSTI_DE = "https://www.osti.gov/dataexplorer/api/v1/records";

export async function searchGeothermalDatasets(query, rows = 15) {
  // OSTI treats '+' literally, so build the query string with %20 by hand.
  const recs = await fetchJson(`${OSTI_DE}?q=${encodeURIComponent(query)}&rows=${rows}`);
  if (!Array.isArray(recs)) throw new Error("Unexpected OSTI response shape.");
  return {
    query,
    returned: recs.length,
    datasets: recs.map((r) => ({
      title: r.title,
      doi: r.doi ?? null,
      published: (r.publication_date ?? "").slice(0, 10) || null,
      authors: (r.authors ?? []).slice(0, 4),
      researchOrgs: r.research_orgs ?? null,
      description: (r.description ?? "").slice(0, 400),
      links: (r.links ?? []).filter((l) => ["fulltext", "doi"].includes(l.rel)).map((l) => l.href),
    })),
  };
}
