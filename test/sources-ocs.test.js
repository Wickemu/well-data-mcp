// OCS (BOEM) lease-qualified names and the borehole file, offline. Every lease, block,
// API number and figure here is invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  boreRecord,
  buildBoreIndex,
  parseOcsName,
  ocsNameWhere,
  boreName,
  boreFacts,
  boundedIn,
  leaseKey,
  wellKey,
  blockKey,
  suffixParts,
  leaseLabel,
} from "../src/sources/boem.js";

const row = (o) => ({
  API_WELL_NUMBER: "",
  WELL_NAME: "",
  WELL_NAME_SUFFIX: "ST00BP00",
  BOTM_LEASE_NUMBER: "",
  BOTM_AREA_CODE: "",
  BOTM_BLOCK_NUMBER: "",
  BH_TOTAL_MD: "",
  WELL_BORE_TVD: "",
  RKB_ELEVATION: "",
  TOTAL_DEPTH_DATE: "",
  SURF_LEASE_NUMBER: "",
  SURF_LATITUDE: "",
  SURF_LONGITUDE: "",
  BOTM_LATITUDE: "",
  BOTM_LONGITUDE: "",
  REGION_CODE: "G",
  ...o,
});

// One Gulf well with two sidetracks, a look-alike on another lease, a bore on an old
// unlettered lease, and a Pacific well.
const ROWS = [
  row({ API_WELL_NUMBER: "608990000100", WELL_NAME: " A007", BOTM_LEASE_NUMBER: "G90001", SURF_LEASE_NUMBER: "G90002", BOTM_AREA_CODE: "ZZ", BOTM_BLOCK_NUMBER: "  901", BH_TOTAL_MD: "10000", WELL_BORE_TVD: "9500", RKB_ELEVATION: "90", TOTAL_DEPTH_DATE: "3/4/2001", SURF_LATITUDE: "27.5", SURF_LONGITUDE: "-90.5", BOTM_LATITUDE: "27.51", BOTM_LONGITUDE: "-90.49" }),
  row({ API_WELL_NUMBER: "608990000101", WELL_NAME: " A007", WELL_NAME_SUFFIX: "ST01BP00", BOTM_LEASE_NUMBER: "G90002", SURF_LEASE_NUMBER: "G90002", BOTM_AREA_CODE: "ZZ", BOTM_BLOCK_NUMBER: "  902", BH_TOTAL_MD: "12000" }),
  row({ API_WELL_NUMBER: "608990000102", WELL_NAME: " A007", WELL_NAME_SUFFIX: "ST01BP01", BOTM_LEASE_NUMBER: "G90002", SURF_LEASE_NUMBER: "G90002", BOTM_AREA_CODE: "ZZ", BOTM_BLOCK_NUMBER: "  902" }),
  row({ API_WELL_NUMBER: "608990000200", WELL_NAME: " A007", BOTM_LEASE_NUMBER: "G90003", SURF_LEASE_NUMBER: "G90003", BOTM_AREA_CODE: "ZZ", BOTM_BLOCK_NUMBER: "  903" }),
  row({ API_WELL_NUMBER: "608990000300", WELL_NAME: " B007", BOTM_LEASE_NUMBER: "G90002", SURF_LEASE_NUMBER: "G90002", BOTM_AREA_CODE: "ZZ", BOTM_BLOCK_NUMBER: "  902" }),
  row({ API_WELL_NUMBER: "177990000400", WELL_NAME: "  012", BOTM_LEASE_NUMBER: " 00777", SURF_LEASE_NUMBER: " 00777", BOTM_AREA_CODE: "QQ", BOTM_BLOCK_NUMBER: "A  12" }),
  row({ API_WELL_NUMBER: "043990000500", WELL_NAME: "  001", BOTM_LEASE_NUMBER: "P00888", SURF_LEASE_NUMBER: "P00888", REGION_CODE: "P" }),
];
const INDEX = buildBoreIndex(ROWS.map(boreRecord));

test("OCS keys: lease, well, block and suffix spellings", () => {
  assert.equal(leaseKey("G90001"), "G|90001");
  assert.equal(leaseKey(" 00777"), "|777");
  assert.equal(wellKey(" A007"), "A|7");
  assert.equal(wellKey("A-7"), "A|7");
  assert.equal(wellKey("#1"), "|1");
  assert.equal(wellKey("  001"), "|1");
  assert.equal(wellKey("No. 12"), "|12");
  assert.equal(wellKey("SN-3"), "SN|3");
  assert.equal(blockKey("ZZ", "  901"), "ZZ|901");
  assert.equal(blockKey("QQ", "A  12"), "QQ|A12");
  assert.deepEqual(suffixParts("ST01BP02"), { st: 1, bp: 2 });
  assert.equal(leaseLabel("G90001"), "OCS-G 90001");
  assert.equal(leaseLabel(" 00777"), "OCS 00777");
  assert.equal(leaseLabel("NOLEASE"), null);
});

test("parseOcsName reads lease and block forms, with a bore tail", () => {
  assert.deepEqual(parseOcsName("OCS-G 90002 A-7", INDEX), { kind: "lease", key: "G|90002", well: "A|7", st: null, bp: null });
  assert.deepEqual(parseOcsName("OCS-G 90002 A-7 ST1", INDEX), { kind: "lease", key: "G|90002", well: "A|7", st: 1, bp: null });
  assert.deepEqual(parseOcsName("OCS-G 90002 A007 ST01BP01", INDEX), { kind: "lease", key: "G|90002", well: "A|7", st: 1, bp: 1 });
  assert.equal(parseOcsName("OCS P-0888 #1", INDEX).key, "P|888");
  assert.equal(parseOcsName("OCS 0777 #12", INDEX).key, "|777");
  assert.equal(parseOcsName("OCS-G 0777 #12", INDEX).key, "|777", "a letter written for an unlettered old lease");
  assert.deepEqual(parseOcsName("ZZ 902 A-7", INDEX), { kind: "block", key: "ZZ|902", well: "A|7", st: null, bp: null });
  assert.equal(parseOcsName("QQ A-12 #12", INDEX).key, "QQ|A12");
  // A bare lease letter counts only for a lease in the file; an area only when the file has it.
  assert.equal(parseOcsName("G-90002 A-7", INDEX).key, "G|90002");
  assert.equal(parseOcsName("G-12345 A-7", INDEX), null);
  assert.equal(parseOcsName("XX 902 A-7", INDEX), null);
  assert.equal(parseOcsName("A007", INDEX), null);
  // Without the file only the 'OCS ...' form is read.
  assert.equal(parseOcsName("OCS-G 90002 A-7").key, "G|90002");
  assert.equal(parseOcsName("ZZ 902 A-7"), null);
});

test("ocsNameWhere: tier 0 the bores on that lease, tier 1 any letters, no Gulf-wide tiers", () => {
  assert.equal(ocsNameWhere(INDEX, "G", "OCS-G 90002 A-7", 0), "API_NUMBER IN ('608990000102','608990000101','608990000100')");
  assert.equal(ocsNameWhere(INDEX, "G", "OCS-G 90002 A-7", 1), "API_NUMBER IN ('608990000300')");
  assert.equal(ocsNameWhere(INDEX, "G", "OCS-G 90002 A-7", 2), null);
  assert.equal(ocsNameWhere(INDEX, "G", "OCS-G 90002 A-7", 3), null);
  // The bottom lease finds the first bore too.
  assert.equal(ocsNameWhere(INDEX, "G", "OCS-G 90001 A007", 0), "API_NUMBER IN ('608990000100')");
  // A sidetrack / bypass in the name narrows to those bores.
  assert.equal(ocsNameWhere(INDEX, "G", "OCS-G 90002 A-7 ST1", 0), "API_NUMBER IN ('608990000102','608990000101')");
  assert.equal(ocsNameWhere(INDEX, "G", "OCS-G 90002 A-7 ST1 BP1", 0), "API_NUMBER IN ('608990000102')");
  assert.equal(ocsNameWhere(INDEX, "G", "ZZ 902 A-7", 0), "API_NUMBER IN ('608990000102','608990000101')");
  // Nothing there: tier 0 asks for nothing rather than giving up, so tier 1 still runs.
  assert.equal(ocsNameWhere(INDEX, "G", "OCS-G 90002 C-7", 0), "1=0");
  assert.equal(ocsNameWhere(INDEX, "G", "OCS-G 90002 C-7", 1), "API_NUMBER IN ('608990000300','608990000102','608990000101','608990000100')");
  // Another region's layer does not see these bores.
  assert.equal(ocsNameWhere(INDEX, "P", "OCS-G 90002 A-7", 0), "1=0");
  assert.equal(ocsNameWhere(INDEX, "P", "OCS P-0888 #1", 0), "API_NUMBER IN ('043990000500')");
  // Not lease-qualified, or no well part: the usual tiers.
  assert.equal(ocsNameWhere(INDEX, "G", "A007", 0), undefined);
  assert.equal(ocsNameWhere(INDEX, "G", "OCS-G 90002", 0), undefined);
  // A plain name whose letters are also an area code, then a sidetrack: still a plain name.
  assert.equal(ocsNameWhere(INDEX, "G", "ZZ001 ST1", 0), undefined);
  assert.equal(ocsNameWhere(INDEX, "G", "ZZ 001 ST01BP00", 0), undefined);
});

test("boreRecord drops a bottom-hole offset that is a placeholder or a typing error", () => {
  const far = boreRecord(row({ API_WELL_NUMBER: "1", SURF_LATITUDE: "27.5", SURF_LONGITUDE: "-90.5", BOTM_LATITUDE: "27.5", BOTM_LONGITUDE: "-93.5" }));
  assert.deepEqual([far[12], far[13]], [null, null]);
  const zero = boreRecord(row({ API_WELL_NUMBER: "2", SURF_LATITUDE: "27.5", SURF_LONGITUDE: "-90.5", BOTM_LATITUDE: "0", BOTM_LONGITUDE: "0" }));
  assert.deepEqual([zero[12], zero[13]], [null, null]);
  const north = boreRecord(row({ API_WELL_NUMBER: "3", SURF_LATITUDE: "27.5", SURF_LONGITUDE: "-90.5", BOTM_LATITUDE: "27.52", BOTM_LONGITUDE: "-90.5" }));
  assert.deepEqual([north[12], north[13]], [0.02, null]);
});

test("boreName and boreFacts", () => {
  const first = INDEX.byApi.get("608990000100");
  assert.equal(boreName(first), "OCS-G 90002 A007", "named for the surface lease");
  assert.equal(boreName(INDEX.byApi.get("608990000101")), "OCS-G 90002 A007 ST1");
  assert.equal(boreName(INDEX.byApi.get("608990000102")), "OCS-G 90002 A007", "a bypass stays in bore");
  assert.equal(boreName(INDEX.byApi.get("177990000400")), "OCS 00777 012");
  const facts = boreFacts(first, { latitude: 27.5003, longitude: -90.5004 });
  assert.deepEqual(facts, {
    lease: "G90001",
    surfaceLease: "G90002",
    areaBlock: "ZZ 901",
    bore: "ST00BP00",
    sidetrack: 0,
    bypass: 0,
    depthMD: 10000,
    depthTVD: 9500,
    depthUnit: "ft",
    rkbElevationFt: 90,
    tdDate: "2001-03-04",
    // the file's offset (+0.01, +0.01) applied to the layer's position
    bottomHoleLatitude: 27.5103,
    bottomHoleLongitude: -90.4904,
  });
  const bare = boreFacts(INDEX.byApi.get("608990000200"), { latitude: 27, longitude: -90 });
  assert.equal(bare.depthUnit, null);
  assert.equal("bottomHoleLatitude" in bare, false, "no offset, no bottom-hole position");
});

test("boundedIn keeps an IN list within what BOEM takes in one (POSTed) query", () => {
  const ids = Array.from({ length: 600 }, (_, i) => String(600000000000 + i));
  const b = boundedIn("API_NUMBER", ids);
  assert.ok(b.kept > 150 && b.kept < 600);
  assert.equal(b.total, 600);
  assert.ok(new URLSearchParams({ where: b.sql }).toString().length <= 4500);
  assert.ok(boundedIn("API_NUMBER", ids, 1400).kept < b.kept, "a smaller budget keeps fewer");
  assert.equal(boundedIn("API_NUMBER", []).sql, "1=0");
  assert.equal(boundedIn("X", ["1", "1", "2"]).sql, "X IN ('1','2')");
});
