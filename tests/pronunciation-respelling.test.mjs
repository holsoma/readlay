import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScript } from "./helpers/load-typescript.mjs";

const { pronunciationRespelling } = loadTypeScript("src/lib/pronunciation-respelling.ts");

test("respelling handles stored dictionary transcriptions, tied affricates and the optional GOAT glide", () => {
  assert.equal(pronunciationRespelling("/kənˈd͡ʒiːniəl/"), "kuhn-JEE-nee-uhl");
  assert.equal(pronunciationRespelling("/kənˈdʒiːniəl/"), "kuhn-JEE-nee-uhl");
  assert.equal(pronunciationRespelling("/ə(ʊ)ˈvɜːt/"), "oh-VURT");
  assert.equal(pronunciationRespelling("/oʊˈvɜːt/"), "oh-VURT");
  assert.equal(pronunciationRespelling("/ˈhæbɪt/"), "HAB-it");
});

test("complete English phonemes are recognised before shorter letters and retain stress", () => {
  assert.equal(pronunciationRespelling("/ˈtʃeɪndʒɪŋ/"), "CHAYN-jing");
  assert.equal(pronunciationRespelling("/əˈθɔːrəti/"), "uh-THAW-ruh-tee");
  assert.equal(pronunciationRespelling("[ˈkʌntri]"), "KUHN-tree");
  assert.equal(pronunciationRespelling("/ˈlɪtəl/"), "LIT-uhl");
  assert.equal(pronunciationRespelling("/ˈlɪtl̩/"), "LIT-uhl");
  assert.equal(pronunciationRespelling("/ˈæplɪkənt/"), "AP-li-kuhnt");
  assert.equal(pronunciationRespelling("/ˈlɪkwɪd/"), "LIK-wid");
  assert.equal(pronunciationRespelling("/ˈækrəbæt/"), "AK-ruh-bat");
  assert.equal(pronunciationRespelling("/ðə/"), "DHUH");
  assert.equal(pronunciationRespelling("/ɹiːd/"), "REED");
  assert.equal(pronunciationRespelling("/maɪnd/"), "MYND");
  assert.equal(pronunciationRespelling("/taɪm/"), "TYM");
  assert.equal(pronunciationRespelling("/aɪ/"), "EYE");
  assert.equal(pronunciationRespelling("/stɑp/"), "STAHP");
  assert.equal(pronunciationRespelling("/θɔt/"), "THAWT");
  assert.equal(pronunciationRespelling("/kɐm/"), "KUHM");
});

test("explicit syllable boundaries and secondary stress do not acquire invented primary stress", () => {
  assert.equal(pronunciationRespelling("/ˈhæ.bɪt/"), "HA-bit");
  assert.equal(pronunciationRespelling("/ˌəʊ.vəˈkʌm/"), "oh-vuh-KUHM");
  assert.equal(pronunciationRespelling("/kən.dʒiː.ni.əl/"), "kuhn-jee-nee-uhl");
  assert.equal(pronunciationRespelling("  /ˈhæbɪt/  "), "HAB-it");
  assert.equal(pronunciationRespelling("/ˌkʌm/"), "kuhm");
});

test("missing, alternative, annotated and unsupported transcriptions fail closed", () => {
  for (const unsupported of [
    null, undefined, "", "habit", "/UK/", "/ˈhæbɪt/, /other/", "/ˈhæbɪt/ /ˈhæbət/",
    "/ˈhæbɪt (UK)/", "/haˈbiːt/", "/ˈhæ̃bɪt/", "/ˈhæbɪt(r)/", "/ˈhæbɪtˈ/",
    "/ˈhæbɪt. /", "/.hæbɪt/", "/hæ..bɪt/", "/ˈˌhæbɪt/", "/ˈhæbɪtˈə/", "/str/",
    "<script>", "/h/", "/a/", "/ˈt͡ʒeɪn/", "/ˈd͡ʃeɪn/", "x".repeat(201),
  ]) assert.equal(pronunciationRespelling(unsupported), null, String(unsupported));
});
