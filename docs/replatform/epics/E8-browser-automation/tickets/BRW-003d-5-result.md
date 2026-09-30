# BRW-003d-5 — Grant-time ceiling and the commit-vector claim — RESULT

**Epic:** E8 · **Lane:** B (`C:\e8`) · **Status:** ✅ complete
**Index:** [`BRW-003d-design.md`](./BRW-003d-design.md)
**End SHA:** see the `feat(BRW-003d-5)` commit
**Discharges:** the "large download" test; closes a live false claim of enforcement.

---

## 1. The ceiling could only fire after the bytes were already in the store

Two enforcement points, two private numbers — one of which did not exist.

- **Commit** already rejected an oversized object, but owned its ceiling privately as a
  `?? 5 * 1024 ** 3` default. The production composition root supplies nothing, so **5 GiB was the
  live value by accident rather than by decision.**
- **Grant** enforced **nothing.** Its declared `maxBytes` is bounded only by
  `Number.MAX_SAFE_INTEGER` in the frozen schema, is passed straight to `presignPut`, and was
  compared to no server limit at all.

So the ceiling could only fire **after** the object was written — at which point the commit refuses
and the uploaded bytes are an **orphan the sweeper has to find**, with the egress already spent.

The grant now refuses a declared size above the ceiling before a byte moves, and the test asserts
**no presign happened**: the grant *is* the capability, so refusing after minting the URL would
defeat the point. Asserting the response said "no" would not have been enough.

`maxBytes` is used purely as **declared intent to refuse on**. That is not the same as trusting it as
an enforced bound at the store — it is not one, and BRW-003b's warning stands.

**One constant, imported by both.** Two enforcement points reading two private numbers is the drift
class.

## 2. ★ The commit-vector header's claim is now true rather than louder

`check-artifact-commit-vectors.mjs` claims two independent implementations *"pin to one fixture,
neither can silently diverge."*

That was **already false**, and not subtly: the fixture had exactly **one** reference in the tree —
the script's own header comment. **The word "two" counted one implementation and one comment.**

Three things fix it:

1. The reference models the ceiling, **with the server's precedence** — before tenant/prefix, so an
   oversized object under a wrong prefix is refused for **size**. Ordering it after the prefix check
   would model a different server.
2. The fixture declares the ceiling in its `context`.
3. A **server-side consumer** pins the fixture to the server's own constant. That is the second
   implementation the header always claimed to have.

## 3. Mutation testing — 4 mutants, 4 killed

| Mutant | Result |
|---|---|
| grant ceiling check removed | killed |
| boundary flipped to `>=` (a legal artifact at the ceiling refused) | killed |
| the shared constant drifts from the fixture | killed |
| the reference drops its ceiling | killed — by the vectors guard itself |

The boundary mutant matters: an off-by-one here refuses a legal artifact, which is the failure a
ceiling is most likely to ship with.

## 4. Verified rather than assumed

- The vectors guard **is** invoked in CI (`pr.yml:202-203`), so it is not one of this programme's
  never-run checks. Its 14 self-tests still pass after the signature change.
- `check-guard-inventory.mjs` OK — 36 guard scripts, all accounted for.

## 5. Verification

- 3 unit + 2 embedded-Postgres tests green; 14 reference self-tests green
- **12,874 server tests green**; the 6 reds are the known pre-existing set
- typecheck clean
