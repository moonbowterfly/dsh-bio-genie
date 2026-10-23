// dsh-bio-genie — A4 ingress S0 tests
// Exercises secure source handling, typed input_snapshot inventory, and
// mutation sensitivity. Fixtures are self-contained and never use temp/ assets.
import { createHash } from 'node:crypto'
import {
  existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ensureCaseDir } from '../src/design-casefile.js'
import {
  INGRESS_LIMITS, classifyIngressBytes, ingestBytes, ingestExternalInput, ingestProducedArtifact,
} from '../src/design-ingress.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SOURCE = readFileSync(join(ROOT, 'src', 'design-ingress.js'), 'utf8')
const roots = []
let pass = 0
let fail = 0
let skip = 0

function check(name, actual, detail = '') {
  if (actual) {
    pass += 1
    console.log('  PASS ' + name)
  } else {
    fail += 1
    console.log('  FAIL ' + name + (detail ? ' :: ' + detail : ''))
  }
}

function skipped(name, detail = '') {
  skip += 1
  console.log('  SKIP ' + name + (detail ? ' :: ' + detail : ''))
}

function root() {
  const d = mkdtempSync(join(tmpdir(), 'design-ingress-'))
  roots.push(d)
  return d
}

function write(base, name, body) {
  const p = join(base, name)
  writeFileSync(p, body)
  return p
}

function digest(body) {
  return createHash('sha256').update(body).digest('hex')
}

function expectedCode(result, code, label) {
  check(label, result.ok === false && result.code === code, JSON.stringify(result).slice(0, 260))
}

function makeMutant(label, mutate) {
  let code = SOURCE
  code = code.replace("from './design-casefile.js'", `from ${JSON.stringify(pathToFileURL(join(ROOT, 'src', 'design-casefile.js')).href)}`)
  code = code.replace("from './design-validate.js'", `from ${JSON.stringify(pathToFileURL(join(ROOT, 'src', 'design-validate.js')).href)}`)
  const changed = mutate(code)
  if (typeof changed !== 'string' || changed === code) throw new Error('mutation did not alter source: ' + label)
  return import('data:text/javascript;base64,' + Buffer.from(changed + `\n// mutant:${label}`).toString('base64'))
}

async function mutation(label, mutate, exercise, weaknessObserved) {
  try {
    const mod = await makeMutant(label, mutate)
    const result = await exercise(mod)
    // A mutation is killed only when the specific property it weakened becomes
    // observably wrong. A loader/runtime crash is deliberately a test failure.
    check('mutation killed: ' + label, weaknessObserved(result), JSON.stringify(result).slice(0, 240))
  } catch (e) {
    check('mutation killed: ' + label, false, 'mutation crashed instead of violating target assertion: ' + String(e.message).slice(0, 160))
  }
}

try {
  // ── R1/R4: content-first secure positive paths + canonical inventory ──
  {
    const d = root()
    const fastaBytes = Buffer.from('>chr1\nACGTACGT\n', 'utf8')
    const fasta = write(d, 'genome.fasta', fastaBytes)
    const r = ingestExternalInput(fasta, { role: 'genome_sequence', originRef: 'upload:genome-1' })
    check('FASTA external ingress succeeds', r.ok && r.inventory.format === 'fasta' && r.inventory.media_type === 'text/x-fasta', JSON.stringify(r))
    check('FASTA same-handle hash/size become inventory identity', r.ok && r.sha256 === digest(fastaBytes) && r.inventory.sha256 === r.sha256 && r.byte_size === fastaBytes.length, JSON.stringify(r))
    check('FASTA inventory is packet canonicalized', r.ok && typeof r.inventory_canonical === 'string' && r.inventory_canonical === JSON.stringify(JSON.parse(r.inventory_canonical)), r.inventory_canonical)
    check('FASTA consumer map is role-specific', r.ok && JSON.stringify(r.inventory.consumer_compatibility) === JSON.stringify(['bio_chassis_profile']), JSON.stringify(r.inventory?.consumer_compatibility))
  }
  {
    const d = root()
    const gff = write(d, 'anno.gff3', '##gff-version 3\nchr1\tunit\tgene\t1\t4\t.\t+\t.\tID=g1\n')
    const r = ingestExternalInput(gff, { role: 'genome_annotation' })
    check('GFF3 external ingress succeeds', r.ok && r.inventory.format === 'gff3' && r.inventory.media_type === 'text/x-gff3', JSON.stringify(r))
    check('GFF3 consumer map supports profiling and integration', r.ok && JSON.stringify(r.inventory.consumer_compatibility) === JSON.stringify(['bio_chassis_profile', 'bio_integration_candidates']), JSON.stringify(r.inventory?.consumer_compatibility))
  }
  {
    const d = root()
    const card = write(d, 'condition.json', '{"medium":"M9","temperature":37}')
    const r = ingestExternalInput(card, { role: 'condition' })
    check('JSON condition ingress succeeds', r.ok && r.inventory.format === 'json' && r.inventory.media_type === 'application/json', JSON.stringify(r))
    check('JSON condition gets only declared consumer', r.ok && JSON.stringify(r.inventory.consumer_compatibility) === JSON.stringify(['bio_chassis_profile']), JSON.stringify(r.inventory?.consumer_compatibility))
  }
  {
    const d = root()
    const sbml = write(d, 'model.sbml', '<?xml version="1.0"?><sbml xmlns="http://www.sbml.org/sbml/level3/version1/core"></sbml>')
    const r = ingestExternalInput(sbml, { role: 'gem_model' })
    check('SBML model ingress succeeds without claiming FBC semantics', r.ok && r.inventory.format === 'sbml' && r.inventory.consumer_compatibility[0] === 'design_consequence', JSON.stringify(r))
  }
  {
    const d = root()
    const sbol = write(d, 'construct.xml', '<?xml version="1.0"?><rdf:RDF xmlns:sbol="http://sbols.org/v3#"><sbol:Component/></rdf:RDF>')
    const r = ingestExternalInput(sbol, { role: 'sbol' })
    check('SBOL XML is content-classified rather than misclassified by .xml suffix', r.ok && r.inventory.format === 'text' && r.classification.detected_kind === 'sbol_xml' && r.inventory.media_type === 'application/rdf+xml', JSON.stringify(r))
  }
  {
    const d = root()
    const genbank = write(d, 'genome.gbk', 'LOCUS       TEST 4 bp DNA\nFEATURES             Location/Qualifiers\nORIGIN\n        1 atgc\n//\n')
    const r = ingestExternalInput(genbank, { role: 'genome_sequence' })
    check('GenBank content confirmation requires structural markers', r.ok && r.inventory.format === 'genbank' && r.inventory.consumer_compatibility[0] === 'bio_chassis_profile', JSON.stringify(r))
    const zip = write(d, 'archive.zip', Buffer.from('PK\x03\x04fixture'))
    const z = ingestExternalInput(zip, { role: 'other' })
    check('ZIP magic is recognized but gets no automatic scientific consumer', z.ok && z.inventory.format === 'zip' && z.inventory.consumer_compatibility.length === 0, JSON.stringify(z))
    const text = write(d, 'evidence.txt', 'curated manually; see provenance')
    const t = ingestExternalInput(text, { role: 'parts_evidence' })
    check('ordinary text is explicitly mapped only for allowed evidence role', t.ok && t.inventory.format === 'text' && JSON.stringify(t.inventory.consumer_compatibility) === JSON.stringify(['bio_chassis_profile', 'bio_circuit_contextualize']), JSON.stringify(t))
  }
  {
    const d = root()
    const sbolJson = write(d, 'construct.json', '{"@context":"https://sbols.org/v3#","sbolVersion":"3"}')
    const sbol = ingestExternalInput(sbolJson, { role: 'sbol' })
    check('SBOL JSON retains frozen json format and SBOL-specific consumers', sbol.ok && sbol.inventory.format === 'json' && sbol.classification.detected_kind === 'sbol_json' && JSON.stringify(sbol.inventory.consumer_compatibility) === JSON.stringify(['bio_circuit_contextualize', 'bio_sbol_read']), JSON.stringify(sbol))
    const cassette = write(d, 'cassette.fa', '>cassette\nACGT\n')
    const c = ingestExternalInput(cassette, { role: 'cassette' })
    check('cassette FASTA has only circuit/integration consumers', c.ok && JSON.stringify(c.inventory.consumer_compatibility) === JSON.stringify(['bio_circuit_contextualize', 'bio_integration_candidates']), JSON.stringify(c))
    const EXPECT_CONSUMER = { gem_card: 'design_consequence', coupling_assumption: 'bio_circuit_contextualize' }
    for (const role of ['gem_card', 'coupling_assumption']) {
      const p = write(d, role + '.json', '{"kind":"' + role + '"}')
      const r = ingestExternalInput(p, { role })
      check(role + ' JSON 只映射到真实注册工具名（' + EXPECT_CONSUMER[role] + '）',
        r.ok && JSON.stringify(r.inventory.consumer_compatibility) === JSON.stringify([EXPECT_CONSUMER[role]]), JSON.stringify(r))
    }
  }
  {
    const d = root()
    const unknown = write(d, 'opaque.bin', Buffer.from([0, 1, 2, 3]))
    const r = ingestExternalInput(unknown, { role: 'other' })
    check('unknown binary is fail-safe other with no consumer', r.ok && r.inventory.format === 'other' && r.inventory.consumer_compatibility.length === 0, JSON.stringify(r))
    const known = ingestExternalInput(unknown, { role: 'gem_card' })
    expectedCode(known, 'INGRESS_ROLE_FORMAT_MISMATCH', 'unknown bytes cannot impersonate typed role')
  }

  // Existing producers receive no trust upgrade; origin_ref is required only
  // for the provenance-bearing produced route.
  {
    const d = root()
    const fasta = write(d, 'tool-output.fa', '>out\nACGT\n')
    const ok = ingestProducedArtifact(fasta, { role: 'genome_sequence', originRef: 'bio_circuit_compile:opaque-output-1' })
    check('produced artifact runs same secure pipeline', ok.ok && ok.inventory.origin.kind === 'ingest_produced' && ok.inventory.origin.origin_ref === 'bio_circuit_compile:opaque-output-1', JSON.stringify(ok))
    expectedCode(ingestProducedArtifact(fasta, { role: 'genome_sequence' }), 'INGRESS_ORIGIN_REF_REQUIRED', 'produced artifact requires stable logical origin_ref')
    expectedCode(ingestBytes(Buffer.from('>inline\nAC\n'), { role: 'genome_sequence', originKind: 'ingest_produced', sourceName: 'inline.fa' }), 'INGRESS_ORIGIN_REF_REQUIRED', 'bytes helper cannot bypass produced-artifact origin audit')
    check('origin_ref accepts frozen 512-character schema boundary', ingestProducedArtifact(fasta, { role: 'genome_sequence', originRef: 'r'.repeat(512) }).ok === true)
    expectedCode(ingestProducedArtifact(fasta, { role: 'genome_sequence', originRef: 'r'.repeat(513) }), 'INGRESS_ORIGIN_REF_INVALID', 'origin_ref over schema boundary rejects')
    expectedCode(ingestProducedArtifact(fasta, { role: 'genome_sequence', originRef: 'tool:\ninvalid' }), 'INGRESS_ORIGIN_REF_INVALID', 'origin_ref controls reject')
  }

  // ── R3/R4: size, parser conflict, and inventory boundaries ──────────
  {
    const d = root()
    const body = Buffer.from('>x\nAC\n', 'utf8')
    const p = write(d, 'limit.fa', body)
    const edge = ingestExternalInput(p, { role: 'genome_sequence', limits: { maxBytes: body.length } })
    check('exact byte limit accepts without over-read', edge.ok && edge.byte_size === body.length, JSON.stringify(edge))
    expectedCode(ingestExternalInput(p, { role: 'genome_sequence', limits: { maxBytes: body.length - 1 } }), 'INGRESS_SIZE_LIMIT', 'one byte above configured ingress limit rejects')
    expectedCode(ingestExternalInput(p, { role: 'genome_sequence', limits: { maxBytes: INGRESS_LIMITS.maxBytes + 1 } }), 'INGRESS_LIMIT_INVALID', 'callers may tighten but never widen default limit')
  }
  {
    const d = root()
    const mismatch = write(d, 'not-a-fasta.fasta', '{"actually":"json"}')
    expectedCode(ingestExternalInput(mismatch, { role: 'genome_sequence' }), 'INGRESS_FORMAT_CONFLICT', 'typed extension conflicts with content sniff')
    const notSbml = write(d, 'not-sbml.sbml', 'ordinary plain text')
    expectedCode(ingestExternalInput(notSbml, { role: 'gem_model' }), 'INGRESS_FORMAT_CONFLICT', 'SBML suffix alone cannot manufacture model type')
    const genericFasta = write(d, 'sequence.txt', '>name\nACGT\n')
    const generic = ingestExternalInput(genericFasta, { role: 'genome_sequence' })
    check('generic text suffix does not override valid FASTA content', generic.ok && generic.inventory.format === 'fasta', JSON.stringify(generic))
  }
  {
    const snap = ingestBytes(Buffer.from('{"x":1}'), { role: 'condition', originKind: 'external', originRef: 'inline:condition' })
    check('bounded caller bytes use same schema/c14n inventory gate', snap.ok && snap.inventory.artifact_type === 'input_snapshot@1' && snap.inventory.origin.kind === 'external', JSON.stringify(snap))
  }

  // ── R2/R5/R6: lexical gate, filesystem gate, and case-handle binding ──
  {
    const lexical = [
      [String.raw`\\server\share\input.fa`, 'INGRESS_UNC_PATH', 'UNC'],
      [String.raw`\\?\C:\input.fa`, 'INGRESS_WINDOWS_NAMESPACE', 'extended namespace'],
      [String.raw`\\.\pipe\design-ingress-a4`, 'INGRESS_PIPE', 'named pipe'],
      [String.raw`C:relative.fa`, 'INGRESS_DRIVE_RELATIVE', 'drive-relative path'],
      ['NUL.txt', 'INGRESS_DEVICE_PATH', 'DOS device component'],
      [String.raw`dir\COM1.json`, 'INGRESS_DEVICE_PATH', 'nested DOS device component'],
      [String.raw`dir\COM1 .json`, 'INGRESS_DEVICE_PATH', 'DOS device alias with pre-extension space'],
      [String.raw`C:\safe\NUL::$DATA`, 'INGRESS_DEVICE_PATH', 'DOS device alternate data stream'],
      [String.raw`C:\safe\COM1:stream`, 'INGRESS_DEVICE_PATH', 'COM device alternate data stream'],
    ]
    for (const [path, code, name] of lexical) expectedCode(ingestExternalInput(path, { role: 'other' }), code, 'lexical reject: ' + name)
  }
  {
    const d = root()
    expectedCode(ingestExternalInput(d, { role: 'other' }), 'INGRESS_DIRECTORY', 'directory source rejects before read')
    const src = write(d, 'hard-source.fa', '>h\nAC\n')
    const hard = join(d, 'hard-link.fa')
    try {
      linkSync(src, hard)
      expectedCode(ingestExternalInput(hard, { role: 'genome_sequence' }), 'INGRESS_HARDLINK', 'hardlink source rejects')
    } catch (e) {
      check('hardlink fixture constructible (never silently skipped)', false, String(e.message))
    }
  }
  {
    const d = root()
    const reparseTarget = join(d, 'final-reparse-target')
    mkdirSync(reparseTarget)
    const finalReparse = join(d, 'final-reparse.fa')
    try {
      symlinkSync(reparseTarget, finalReparse, 'junction')
      expectedCode(ingestExternalInput(finalReparse, { role: 'genome_sequence' }), 'INGRESS_REPARSE_POINT', 'final junction/reparse component rejects')
      expectedCode(ingestProducedArtifact(finalReparse, { role: 'genome_sequence', originRef: 'tool:final-link' }), 'INGRESS_REPARSE_POINT', 'produced route rejects final junction/reparse component')
    } catch (e) {
      check('final junction fixture constructible (never silently skipped)', false, String(e.message))
    }
  }
  {
    const d = root()
    const target = join(d, 'junction-target')
    mkdirSync(target)
    write(target, 'payload.fa', '>j\nACGT\n')
    const junction = join(d, 'junction-ancestor')
    try {
      symlinkSync(target, junction, 'junction')
      const throughJunction = join(junction, 'payload.fa')
      expectedCode(ingestExternalInput(throughJunction, { role: 'genome_sequence' }), 'INGRESS_REPARSE_POINT', 'ancestor junction/reparse rejects before file read')
      expectedCode(ingestProducedArtifact(throughJunction, { role: 'genome_sequence', originRef: 'tool:1' }), 'INGRESS_REPARSE_POINT', 'produced route rejects same ancestor junction')
    } catch (e) {
      check('junction fixture constructible (never silently skipped)', false, String(e.message))
    }
  }
  {
    const d = root()
    const target = write(d, 'native-target.fa', '>s\nACGT\n')
    const link = join(d, 'native-link.fa')
    try {
      symlinkSync(target, link, 'file')
      expectedCode(ingestExternalInput(link, { role: 'genome_sequence' }), 'INGRESS_REPARSE_POINT', 'native file symlink rejects')
    } catch (e) {
      // Windows may deny native file symlink creation to a non-developer user.
      // The mandatory junction assertion above still exercises the same gate.
      skipped('native file symlink unavailable; final-junction gate remains mandatory', String(e.code || e.message))
    }
  }
  {
    const d = root()
    const source = write(d, 'contained.fa', '>c\nAC\n')
    const handle = ensureCaseDir(d, 'safe-case')
    const ok = ingestExternalInput(source, { role: 'genome_sequence', caseHandle: handle })
    check('validated A1 case handle may be attached without writing case files', ok.ok && existsSync(handle.objectsDir), JSON.stringify(ok))
    const unsafe = { ...handle, objectsDir: d }
    expectedCode(ingestExternalInput(source, { role: 'genome_sequence', caseHandle: unsafe }), 'INGRESS_CASE_TARGET_ESCAPE', 'case target escape is rejected')
    const proxy = join(d, 'case-parent-proxy')
    try {
      symlinkSync(join(d, 'result', 'design'), proxy, 'junction')
      const proxied = {
        ...handle,
        caseDir: join(proxy, 'safe-case'),
        objectsDir: join(proxy, 'safe-case', 'objects'),
        snapshotsDir: join(proxy, 'safe-case', 'snapshots'),
      }
      expectedCode(ingestExternalInput(source, { role: 'genome_sequence', caseHandle: proxied }), 'INGRESS_CASE_HANDLE_UNSAFE', 'case handle rejects ancestor junction even when it resolves inside case root')
    } catch (e) {
      check('case ancestor junction fixture constructible (never silently skipped)', false, String(e.message))
    }
  }
  {
    for (const key of ['objectsDir', 'snapshotsDir']) {
      const d = root()
      const source = write(d, 'case-subdir.fa', '>c\nAC\n')
      const handle = ensureCaseDir(d, 'subdir-case')
      const outside = join(d, 'outside-' + key)
      mkdirSync(outside)
      try {
        rmSync(handle[key], { recursive: true, force: true })
        symlinkSync(outside, handle[key], 'junction')
        expectedCode(ingestExternalInput(source, { role: 'genome_sequence', caseHandle: handle }), 'INGRESS_CASE_TARGET_ESCAPE', `case ${key} final junction rejects`)
      } catch (e) {
        check(`case ${key} junction fixture constructible (never silently skipped)`, false, String(e.message))
      }
    }
  }
  {
    const d = root()
    const source = write(d, 'case-final.fa', '>c\nAC\n')
    const handle = ensureCaseDir(d, 'final-case')
    const proxy = join(d, 'case-final-proxy')
    try {
      symlinkSync(handle.caseDir, proxy, 'junction')
      const proxied = { ...handle, caseDir: proxy, objectsDir: join(proxy, 'objects'), snapshotsDir: join(proxy, 'snapshots') }
      expectedCode(ingestExternalInput(source, { role: 'genome_sequence', caseHandle: proxied }), 'INGRESS_CASE_HANDLE_UNSAFE', 'case handle final junction rejects')
    } catch (e) {
      check('case final junction fixture constructible (never silently skipped)', false, String(e.message))
    }
  }
  {
    if (process.platform !== 'win32') {
      skipped('Windows case alias fixture', 'case aliases are a Windows-specific path semantic')
    } else {
      const d = root()
      const source = write(d, 'case-alias.fa', '>c\nAC\n')
      const handle = ensureCaseDir(d, 'case-alias')
      const aliasDir = handle.caseDir.replace(/case-alias$/i, 'CASE-ALIAS')
      const aliased = { ...handle, caseDir: aliasDir, objectsDir: join(aliasDir, 'objects'), snapshotsDir: join(aliasDir, 'snapshots') }
      expectedCode(ingestExternalInput(source, { role: 'genome_sequence', caseHandle: aliased }), 'INGRESS_CASE_ALIAS_CONFLICT', 'case-handle Windows case alias rejects')
    }
  }
  {
    // R5 parity: there is no trust downgrade for tool-produced bytes.  These
    // failures must be produced by the shared source reader/classifier, not
    // only by the external wrapper.
    const d = root()
    const tooLarge = write(d, 'parity-size.fa', '>p\nACGT\n')
    const mismatch = write(d, 'parity-format.fa', '{"not":"fasta"}')
    const roleMismatch = write(d, 'parity-role.json', '{"card":true}')
    const pairs = [
      [tooLarge, { role: 'genome_sequence', limits: { maxBytes: 1 } }, 'INGRESS_SIZE_LIMIT'],
      [mismatch, { role: 'genome_sequence' }, 'INGRESS_FORMAT_CONFLICT'],
      [roleMismatch, { role: 'genome_sequence' }, 'INGRESS_ROLE_FORMAT_MISMATCH'],
    ]
    for (const [p, opts, code] of pairs) {
      const external = ingestExternalInput(p, opts)
      const produced = ingestProducedArtifact(p, { ...opts, originRef: 'tool:parity:' + code })
      check('external/produced share rejection protocol: ' + code, external.ok === false && produced.ok === false && external.code === code && produced.code === code, JSON.stringify({ external, produced }))
    }
  }

  // ── R7: four real mutations; crashes do not count as killed ──────────
  {
    const d = root()
    const target = join(d, 'mut-junction-target')
    mkdirSync(target)
    write(target, 'payload.fa', '>m\nACGT\n')
    const junction = join(d, 'mut-junction')
    try {
      symlinkSync(target, junction, 'junction')
      await mutation(
        'ancestor-reparse gate removed',
        (s) => s.replace('const ancestorOk = assertNoReparseAncestors(sourcePath)', 'const ancestorOk = { ok: true }'),
        (m) => m.ingestExternalInput(join(junction, 'payload.fa'), { role: 'genome_sequence' }),
        (r) => r.ok === true,
      )
    } catch (e) {
      check('reparse mutation fixture constructible (never silently skipped)', false, String(e.message))
    }
  }
  {
    const d = root()
    const p = write(d, 'mut-c14n.fa', '>m\nACGT\n')
    await mutation(
      'set duplicate is rejected by frozen c14n',
      (s) => s.replace("return ['bio_chassis_profile']", "return ['bio_chassis_profile', 'bio_chassis_profile']"),
      (m) => m.ingestExternalInput(p, { role: 'genome_sequence' }),
      (r) => r.ok === false && r.code === 'INGRESS_INVENTORY_CANONICAL_INVALID',
    )
  }
  {
    const d = root()
    const p = write(d, 'mut-schema.fa', '>m\nACGT\n')
    await mutation(
      'schema gate rejects malformed inventory type',
      (s) => s.replace("artifact_type: 'input_snapshot@1'", "artifact_type: 'not-input-snapshot@1'"),
      (m) => m.ingestExternalInput(p, { role: 'genome_sequence' }),
      (r) => r.ok === false && r.code === 'INGRESS_INVENTORY_INVALID',
    )
  }
  {
    const d = root()
    const body = Buffer.from('>m\nACGT\n')
    const p = write(d, 'mut-size.fa', body)
    await mutation(
      'size gates removed',
      (s) => s
        .replace('if (before.size > maxBytes)', 'if (false)')
        .replace('if (opened.size > maxBytes)', 'if (false)')
        .replace('if (offset > maxBytes)', 'if (false)'),
      (m) => m.ingestExternalInput(p, { role: 'genome_sequence', limits: { maxBytes: body.length - 1 } }),
      (r) => r.ok === true && r.byte_size === body.length,
    )
  }
  {
    const d = root()
    const body = Buffer.from('>m\nACGT\n')
    const p = write(d, 'mut-hash.fa', body)
    await mutation(
      'TS recomputed hash replaced',
      (s) => s.replace("return createHash('sha256').update(bytes).digest('hex')", "return '0'.repeat(64)"),
      (m) => m.ingestExternalInput(p, { role: 'genome_sequence' }),
      (r) => r.ok === true && r.sha256 !== digest(body),
    )
  }
  {
    const d = root()
    const p = write(d, 'mut-classifier.txt', '>m\nACGT\n')
    await mutation(
      'FASTA classifier altered',
      (s) => s.replace("detected = { format: 'fasta', detected_kind: 'fasta' }", "detected = { format: 'other', detected_kind: 'mutant_fasta' }"),
      (m) => m.ingestExternalInput(p, { role: 'genome_sequence' }),
      (r) => r.ok === false && r.code === 'INGRESS_ROLE_FORMAT_MISMATCH',
    )
  }
} finally {
  for (const d of roots) rmSync(d, { recursive: true, force: true })
}

console.log(`design-ingress: ${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`)
if (fail) process.exitCode = 1
