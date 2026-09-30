import { describe, expect, it } from 'vitest';
import { removeOverrideKeys } from '../src/files/json-text.js';

describe('removeOverrideKeys', () => {
  it('removes a middle member and keeps the rest of the file byte for byte', () => {
    const text = `{
  "name": "x",
  "files": ["dist"],
  "overrides": {
    "a@<1": "^1",
    "b@<2": "^2",
    "c@<3": "^3"
  }
}
`;
    expect(removeOverrideKeys(text, ['b@<2'])).toBe(`{
  "name": "x",
  "files": ["dist"],
  "overrides": {
    "a@<1": "^1",
    "c@<3": "^3"
  }
}
`);
  });

  it('removes the last member without leaving a trailing comma', () => {
    const text = '{\n  "overrides": {\n    "a": "1",\n    "b": "2"\n  },\n  "z": 1\n}\n';
    expect(removeOverrideKeys(text, ['b'])).toBe(
      '{\n  "overrides": {\n    "a": "1"\n  },\n  "z": 1\n}\n',
    );
  });

  it('removes the whole overrides field when it becomes empty', () => {
    const text =
      '{\r\n  "name": "x",\r\n  "overrides": {\r\n    "a": "1"\r\n  },\r\n  "z": 1\r\n}\r\n';
    expect(removeOverrideKeys(text, ['a'])).toBe('{\r\n  "name": "x",\r\n  "z": 1\r\n}\r\n');
  });

  it('removes overrides when it is the last top-level field', () => {
    const text = '{\n  "name": "x",\n  "overrides": {\n    "a": "1"\n  }\n}\n';
    expect(removeOverrideKeys(text, ['a'])).toBe('{\n  "name": "x"\n}\n');
  });

  it('ignores keys inside nested values and strings containing braces', () => {
    const text =
      '{\n  "description": "a } b",\n  "overrides": {\n    "p": { "a": "9" },\n    "a": "1"\n  }\n}\n';
    expect(removeOverrideKeys(text, ['a'])).toBe(
      '{\n  "description": "a } b",\n  "overrides": {\n    "p": { "a": "9" }\n  }\n}\n',
    );
  });

  it('matches escaped keys by their decoded value', () => {
    const text = '{\n  "overrides": {\n    "a\\u0040<1": "1",\n    "b": "2"\n  }\n}\n';
    expect(removeOverrideKeys(text, ['a@<1'])).toBe('{\n  "overrides": {\n    "b": "2"\n  }\n}\n');
  });
});
