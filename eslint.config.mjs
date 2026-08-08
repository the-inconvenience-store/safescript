import nx from '@nx/eslint-plugin';

export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  {
    ignores: ['**/dist', '**/.nx'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          depConstraints: [
            {
              sourceTag: 'layer:contracts',
              onlyDependOnLibsWithTags: ['layer:contracts'],
            },
            {
              sourceTag: 'layer:engine',
              onlyDependOnLibsWithTags: ['layer:contracts'],
            },
            {
              sourceTag: 'layer:sdk',
              onlyDependOnLibsWithTags: ['layer:engine', 'layer:contracts'],
            },
            {
              sourceTag: 'layer:cli',
              onlyDependOnLibsWithTags: ['layer:sdk', 'layer:contracts'],
            },
            {
              sourceTag: 'layer:conformance',
              onlyDependOnLibsWithTags: ['layer:contracts', 'layer:engine', 'layer:sdk'],
            },
            {
              sourceTag: 'layer:example',
              onlyDependOnLibsWithTags: ['layer:contracts', 'layer:sdk'],
            },
          ],
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@safescript/*/*'],
              message: 'Import another project through its public package entry point.',
            },
          ],
        },
      ],
    },
  },
];
