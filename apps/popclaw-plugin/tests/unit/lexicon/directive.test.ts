import { afterEach, describe, expect, it } from 'vitest';
import { languageDirective, renderDirective } from '../../../src/lexicon/directive.js';
import { lexiconFor } from '../../../src/lexicon/index.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';

afterEach(() => setOwnerLang(undefined));

describe('languageDirective', () => {
  it('names the BCP-47 tag it was given', () => {
    expect(languageDirective('en', 'en-GB')).toContain('Speak to the owner in en-GB');
  });

  it('carries both sides of the glossary on the zh lane', () => {
    const d = languageDirective('zh-CN', 'zh-CN');
    const zh = lexiconFor('zh-CN').terms;
    const en = lexiconFor('en').terms;
    expect(d).toContain(`${en.loreHouse}=${zh.loreHouse}`);
    expect(d).toContain(`${en.ranger}=${zh.ranger}`);
    expect(d).toContain(`${en.sigil}=${zh.sigil}`);
  });

  it('prints bare terms on the en lane rather than term=term', () => {
    const d = languageDirective('en', 'en-US');
    const en = lexiconFor('en').terms;
    expect(d).toContain(en.loreHouse);
    expect(d).not.toContain(`${en.loreHouse}=`);
  });

  it('follows the process register when called with no arguments', () => {
    setOwnerLang('zh-CN');
    const d = languageDirective();
    expect(d).toContain('Speak to the owner in zh-CN');
    expect(d).toContain(lexiconFor('zh-CN').terms.loreHouse);
  });

  it('names no language at all when nothing is known about the owner', () => {
    const d = languageDirective();
    expect(d).not.toContain('Speak to the owner in en-US');
    expect(d).toMatch(/whatever language they are writing to you in/);
    // The pinned terms still come from the en lexicon.
    expect(d).toContain(lexiconFor('en').terms.loreHouse);
  });

  it('names no language when only the host locale has spoken (env is not the owner)', () => {
    // `LANG=en_US.UTF-8` is a near-constant on developer machines, an MCP host
    // hands it straight to the server it spawns, and it used to make popclaw
    // tell the agent "speak en-US" to an owner writing Chinese (2026-08-24).
    setOwnerLang('en-US', 'env');
    const d = languageDirective();
    expect(d).not.toContain('Speak to the owner in en-US');
    expect(d).toMatch(/whatever language they are writing to you in/);
  });

  it('tells the agent not to translate what other people wrote', () => {
    expect(languageDirective('en', 'en-US')).toMatch(/never translate what someone else wrote/);
  });
});

describe('renderDirective — 排版指令', () => {
  it('names the command and the config path, the two things hosts kept dropping', () => {
    const d = renderDirective();
    expect(d).toContain('including the command after the arrow');
    expect(d).toContain('Never drop the \u2699 config line or its path');
  });

  it('bans the markup that shatters on a phone, and says what is still allowed', () => {
    const d = renderDirective();
    for (const banned of ['no tables', '> blockquotes', '--- dividers', '[text](url) links', 'inline backticks']) {
      expect(d).toContain(banned);
    }
    expect(d).toContain('Bare URLs');
  });

  it('says up front that it is not for the owner — it rides in the tool result, where it could be echoed', () => {
    expect(renderDirective()).toContain('never show these lines to them');
  });

  it('stays CJK-free — the model reads it, the owner never does', () => {
    expect(renderDirective()).not.toMatch(/[\u4e00-\u9fa5]/);
  });
});
