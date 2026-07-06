# Pending sets - drafted, blocked at the uniqueness gate

Five round-2 sets (bands 3-4 + bank-B expansion), parked here on 2026-07-06
because the OpenAI account ran out of quota mid-judging (`insufficient_quota`
on both gpt-5.5 and gpt-4.1; verified with a 1-token probe). The G9 gate is a
cross-vendor ensemble by design, so it cannot run on the Anthropic key alone.

State when parked: rosters vetted (WordNet pins, G3/G4/G5 checks; a planned
break-01 set was REJECTED at vet - snap.v.03 carries 'crack' and tear.v.01
carries 'snap' as lemmas), sentences drafted by gpt-5.5 and human-scrubbed
(register pass applied), grades attached, difficulty scored, gloss audit
green. Judged so far: A-look-01 s01-s10 only (verdicts already in
reference/uniqueness/A-look-01.json).

To resume once quota is restored:

    mv reference/pending-sets/look-01.json sets/A/
    mv reference/pending-sets/say-01.json sets/A/
    mv reference/pending-sets/water-move-01.json sets/A/
    mv reference/pending-sets/water-01.json sets/B/
    mv reference/pending-sets/landform-01.json sets/B/
    SETS_ONLY="A-look-01,A-say-01,A-water-move-01,B-water-01,B-landform-01" \
        python3 tools/judge-uniqueness.py

then the usual chain: triage flags, stamp waivers, stamp scrubbed_at,
validate-sets, bake-content, test-content, test-core, headless check, commit.
Hash-skip resumes judging exactly where it stopped.
