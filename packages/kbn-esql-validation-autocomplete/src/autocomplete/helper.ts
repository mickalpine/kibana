/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type {
  ESQLAstItem,
  ESQLCommand,
  ESQLFunction,
  ESQLLiteral,
  ESQLSource,
} from '@kbn/esql-ast';
import { uniqBy } from 'lodash';
import type {
  FunctionDefinition,
  FunctionReturnType,
  SupportedDataType,
} from '../definitions/types';
import {
  findFinalWord,
  getColumnForASTNode,
  getFunctionDefinition,
  isAssignment,
  isColumnItem,
  isFunctionItem,
  isLiteralItem,
  isTimeIntervalItem,
} from '../shared/helpers';
import type { GetColumnsByTypeFn, SuggestionRawDefinition } from './types';
import { compareTypesWithLiterals } from '../shared/esql_types';
import {
  TIME_SYSTEM_PARAMS,
  buildVariablesDefinitions,
  getCompatibleFunctionDefinition,
  getCompatibleLiterals,
  getDateLiterals,
} from './factories';
import { EDITOR_MARKER } from '../shared/constants';
import { ESQLRealField, ESQLVariable, ReferenceMaps } from '../validation/types';

function extractFunctionArgs(args: ESQLAstItem[]): ESQLFunction[] {
  return args.flatMap((arg) => (isAssignment(arg) ? arg.args[1] : arg)).filter(isFunctionItem);
}

function checkContent(fn: ESQLFunction): boolean {
  const fnDef = getFunctionDefinition(fn.name);
  return (!!fnDef && fnDef.type === 'agg') || extractFunctionArgs(fn.args).some(checkContent);
}

export function isAggFunctionUsedAlready(command: ESQLCommand, argIndex: number) {
  if (argIndex < 0) {
    return false;
  }
  const arg = command.args[argIndex];
  return isFunctionItem(arg) ? checkContent(arg) : false;
}

function getFnContent(fn: ESQLFunction): string[] {
  return [fn.name].concat(extractFunctionArgs(fn.args).flatMap(getFnContent));
}

export function getFunctionsToIgnoreForStats(command: ESQLCommand, argIndex: number) {
  if (argIndex < 0) {
    return [];
  }
  const arg = command.args[argIndex];
  return isFunctionItem(arg) ? getFnContent(arg) : [];
}

/**
 * Given a function signature, returns the parameter at the given position, even if it's undefined or null
 *
 * @param {params}
 * @param position
 * @returns
 */
export function strictlyGetParamAtPosition(
  { params }: FunctionDefinition['signatures'][number],
  position: number
) {
  return params[position] ? params[position] : null;
}

export function getQueryForFields(queryString: string, commands: ESQLCommand[]) {
  // If there is only one source command and it does not require fields, do not
  // fetch fields, hence return an empty string.
  return commands.length === 1 && ['row', 'show'].includes(commands[0].name) ? '' : queryString;
}

export function getSourcesFromCommands(commands: ESQLCommand[], sourceType: 'index' | 'policy') {
  const fromCommand = commands.find(({ name }) => name === 'from');
  const args = (fromCommand?.args ?? []) as ESQLSource[];
  return args.filter((arg) => arg.sourceType === sourceType);
}

export function removeQuoteForSuggestedSources(suggestions: SuggestionRawDefinition[]) {
  return suggestions.map((d) => ({
    ...d,
    // "text" -> text
    text: d.text.startsWith('"') && d.text.endsWith('"') ? d.text.slice(1, -1) : d.text,
  }));
}

export function getSupportedTypesForBinaryOperators(
  fnDef: FunctionDefinition | undefined,
  previousType: string
) {
  // Retrieve list of all 'right' supported types that match the left hand side of the function
  return fnDef && Array.isArray(fnDef?.signatures)
    ? fnDef.signatures
        .filter(({ params }) => params.find((p) => p.name === 'left' && p.type === previousType))
        .map(({ params }) => params[1].type)
    : [previousType];
}

export function getValidFunctionSignaturesForPreviousArgs(
  fnDefinition: FunctionDefinition,
  enrichedArgs: Array<
    ESQLAstItem & {
      dataType: string;
    }
  >,
  argIndex: number
) {
  // Filter down to signatures that match every params up to the current argIndex
  // e.g. BUCKET(longField, /) => all signatures with first param as long column type
  // or BUCKET(longField, 2, /) => all signatures with (longField, integer, ...)
  const relevantFuncSignatures = fnDefinition.signatures.filter(
    (s) =>
      s.params?.length >= argIndex &&
      s.params.slice(0, argIndex).every(({ type: dataType }, idx) => {
        return (
          dataType === enrichedArgs[idx].dataType ||
          compareTypesWithLiterals(dataType, enrichedArgs[idx].dataType)
        );
      })
  );
  return relevantFuncSignatures;
}

/**
 * Given a function signature, returns the compatible types to suggest for the next argument
 *
 * @param fnDefinition: the function definition
 * @param enrichedArgs: AST args with enriched esType info to match with function signatures
 * @param argIndex: the index of the argument to suggest for
 * @returns
 */
export function getCompatibleTypesToSuggestNext(
  fnDefinition: FunctionDefinition,
  enrichedArgs: Array<
    ESQLAstItem & {
      dataType: string;
    }
  >,
  argIndex: number
) {
  // First, narrow down to valid function signatures based on previous arguments
  const relevantFuncSignatures = getValidFunctionSignaturesForPreviousArgs(
    fnDefinition,
    enrichedArgs,
    argIndex
  );

  // Then, get the compatible types to suggest for the next argument
  const compatibleTypesToSuggestForArg = uniqBy(
    relevantFuncSignatures.map((f) => f.params[argIndex]).filter((d) => d),
    (o) => `${o.type}-${o.constantOnly}`
  );
  return compatibleTypesToSuggestForArg;
}

/**
 * Checks the suggestion text for overlap with the current query.
 *
 * This is useful to determine the range of the existing query that should be
 * replaced if the suggestion is accepted.
 *
 * For example
 * QUERY: FROM source | WHERE field IS NO
 * SUGGESTION: IS NOT NULL
 *
 * The overlap is "IS NO" and the range to replace is "IS NO" in the query.
 *
 * @param query
 * @param suggestionText
 * @returns
 */
export function getOverlapRange(
  query: string,
  suggestionText: string
): { start: number; end: number } {
  let overlapLength = 0;

  // Convert both strings to lowercase for case-insensitive comparison
  const lowerQuery = query.toLowerCase();
  const lowerSuggestionText = suggestionText.toLowerCase();

  for (let i = 0; i <= lowerSuggestionText.length; i++) {
    const substr = lowerSuggestionText.substring(0, i);
    if (lowerQuery.endsWith(substr)) {
      overlapLength = i;
    }
  }

  return {
    start: Math.min(query.length - overlapLength + 1, query.length),
    end: query.length,
  };
}

function isValidDateString(dateString: unknown): boolean {
  if (typeof dateString !== 'string') return false;
  const timestamp = Date.parse(dateString.replace(/\"/g, ''));
  return !isNaN(timestamp);
}

/**
 * Returns true is node is a valid literal that represents a date
 * either a system time parameter or a date string generated by date picker
 * @param dateString
 * @returns
 */
export function isLiteralDateItem(nodeArg: ESQLAstItem): boolean {
  return (
    isLiteralItem(nodeArg) &&
    // If text is ?start or ?end, it's a system time parameter
    (TIME_SYSTEM_PARAMS.includes(nodeArg.text) ||
      // Or if it's a string generated by date picker
      isValidDateString(nodeArg.value))
  );
}

export function getValidSignaturesAndTypesToSuggestNext(
  node: ESQLFunction,
  references: { fields: Map<string, ESQLRealField>; variables: Map<string, ESQLVariable[]> },
  fnDefinition: FunctionDefinition,
  fullText: string,
  offset: number
) {
  const enrichedArgs = node.args.map((nodeArg) => {
    let dataType = extractTypeFromASTArg(nodeArg, references);

    // For named system time parameters ?start and ?end, make sure it's compatiable
    if (isLiteralDateItem(nodeArg)) {
      dataType = 'date';
    }

    return { ...nodeArg, dataType } as ESQLAstItem & { dataType: string };
  });

  // pick the type of the next arg
  const shouldGetNextArgument = node.text.includes(EDITOR_MARKER);
  let argIndex = Math.max(node.args.length, 0);
  if (!shouldGetNextArgument && argIndex) {
    argIndex -= 1;
  }

  const validSignatures = getValidFunctionSignaturesForPreviousArgs(
    fnDefinition,
    enrichedArgs,
    argIndex
  );
  // Retrieve unique of types that are compatiable for the current arg
  const typesToSuggestNext = getCompatibleTypesToSuggestNext(fnDefinition, enrichedArgs, argIndex);
  const hasMoreMandatoryArgs = !validSignatures
    // Types available to suggest next after this argument is completed
    .map((signature) => strictlyGetParamAtPosition(signature, argIndex + 1))
    // when a param is null, it means param is optional
    // If there's at least one param that is optional, then
    // no need to suggest comma
    .some((p) => p === null || p?.optional === true);

  // Whether to prepend comma to suggestion string
  // E.g. if true, "fieldName" -> "fieldName, "
  const alreadyHasComma = fullText ? fullText[offset] === ',' : false;
  const shouldAddComma =
    hasMoreMandatoryArgs && fnDefinition.type !== 'builtin' && !alreadyHasComma;
  const currentArg = enrichedArgs[argIndex];
  return {
    shouldAddComma,
    typesToSuggestNext,
    validSignatures,
    hasMoreMandatoryArgs,
    enrichedArgs,
    argIndex,
    currentArg,
  };
}

/**
 * This function handles the logic to suggest completions
 * for a given fragment of text in a generic way. A good example is
 * a field name.
 *
 * When typing a field name, there are 2 scenarios
 *
 * 1. field name is incomplete (includes the empty string)
 * KEEP /
 * KEEP fie/
 *
 * 2. field name is complete
 * KEEP field/
 *
 * This function provides a framework for detecting and handling both scenarios in a clean way.
 *
 * @param innerText - the query text before the current cursor position
 * @param isFragmentComplete — return true if the fragment is complete
 * @param getSuggestionsForIncomplete — gets suggestions for an incomplete fragment
 * @param getSuggestionsForComplete - gets suggestions for a complete fragment
 * @returns
 */
export function handleFragment(
  innerText: string,
  isFragmentComplete: (fragment: string) => boolean,
  getSuggestionsForIncomplete: (
    fragment: string,
    rangeToReplace?: { start: number; end: number }
  ) => SuggestionRawDefinition[] | Promise<SuggestionRawDefinition[]>,
  getSuggestionsForComplete: (
    fragment: string,
    rangeToReplace: { start: number; end: number }
  ) => SuggestionRawDefinition[] | Promise<SuggestionRawDefinition[]>
): SuggestionRawDefinition[] | Promise<SuggestionRawDefinition[]> {
  /**
   * @TODO — this string manipulation is crude and can't support all cases
   * Checking for a partial word and computing the replacement range should
   * really be done using the AST node, but we'll have to refactor further upstream
   * to make that available. This is a quick fix to support the most common case.
   */
  const fragment = findFinalWord(innerText);
  if (!fragment) {
    return getSuggestionsForIncomplete('');
  } else {
    const rangeToReplace = {
      start: innerText.length - fragment.length + 1,
      end: innerText.length + 1,
    };
    if (isFragmentComplete(fragment)) {
      return getSuggestionsForComplete(fragment, rangeToReplace);
    } else {
      return getSuggestionsForIncomplete(fragment, rangeToReplace);
    }
  }
}
/**
 * TODO — split this into distinct functions, one for fields, one for functions, one for literals
 */
export async function getFieldsOrFunctionsSuggestions(
  types: string[],
  commandName: string,
  optionName: string | undefined,
  getFieldsByType: GetColumnsByTypeFn,
  {
    functions,
    fields,
    variables,
    literals = false,
  }: {
    functions: boolean;
    fields: boolean;
    variables?: Map<string, ESQLVariable[]>;
    literals?: boolean;
  },
  {
    ignoreFn = [],
    ignoreColumns = [],
  }: {
    ignoreFn?: string[];
    ignoreColumns?: string[];
  } = {}
): Promise<SuggestionRawDefinition[]> {
  const filteredFieldsByType = pushItUpInTheList(
    (await (fields
      ? getFieldsByType(types, ignoreColumns, {
          advanceCursor: commandName === 'sort',
          openSuggestions: commandName === 'sort',
        })
      : [])) as SuggestionRawDefinition[],
    functions
  );

  const filteredVariablesByType: string[] = [];
  if (variables) {
    for (const variable of variables.values()) {
      if (
        (types.includes('any') || types.includes(variable[0].type)) &&
        !ignoreColumns.includes(variable[0].name)
      ) {
        filteredVariablesByType.push(variable[0].name);
      }
    }
    // due to a bug on the ES|QL table side, filter out fields list with underscored variable names (??)
    // avg( numberField ) => avg_numberField_
    const ALPHANUMERIC_REGEXP = /[^a-zA-Z\d]/g;
    if (
      filteredVariablesByType.length &&
      filteredVariablesByType.some((v) => ALPHANUMERIC_REGEXP.test(v))
    ) {
      for (const variable of filteredVariablesByType) {
        const underscoredName = variable.replace(ALPHANUMERIC_REGEXP, '_');
        const index = filteredFieldsByType.findIndex(
          ({ label }) => underscoredName === label || `_${underscoredName}_` === label
        );
        if (index >= 0) {
          filteredFieldsByType.splice(index);
        }
      }
    }
  }
  // could also be in stats (bucket) but our autocomplete is not great yet
  const displayDateSuggestions = types.includes('date') && ['where', 'eval'].includes(commandName);

  const suggestions = filteredFieldsByType.concat(
    displayDateSuggestions ? getDateLiterals() : [],
    functions ? getCompatibleFunctionDefinition(commandName, optionName, types, ignoreFn) : [],
    variables
      ? pushItUpInTheList(buildVariablesDefinitions(filteredVariablesByType), functions)
      : [],
    literals ? getCompatibleLiterals(commandName, types) : []
  );

  return suggestions;
}

export function pushItUpInTheList(suggestions: SuggestionRawDefinition[], shouldPromote: boolean) {
  if (!shouldPromote) {
    return suggestions;
  }
  return suggestions.map(({ sortText, ...rest }) => ({
    ...rest,
    sortText: `1${sortText}`,
  }));
}

export function extractTypeFromASTArg(
  arg: ESQLAstItem,
  references: Pick<ReferenceMaps, 'fields' | 'variables'>
):
  | ESQLLiteral['literalType']
  | SupportedDataType
  | FunctionReturnType
  | 'timeInterval'
  | string // @TODO remove this
  | undefined {
  if (Array.isArray(arg)) {
    return extractTypeFromASTArg(arg[0], references);
  }
  if (isColumnItem(arg) || isLiteralItem(arg)) {
    if (isLiteralItem(arg)) {
      return arg.literalType;
    }
    if (isColumnItem(arg)) {
      const hit = getColumnForASTNode(arg, references);
      if (hit) {
        return hit.type;
      }
    }
  }
  if (isTimeIntervalItem(arg)) {
    return arg.type;
  }
  if (isFunctionItem(arg)) {
    const fnDef = getFunctionDefinition(arg.name);
    if (fnDef) {
      // @TODO: improve this to better filter down the correct return type based on existing arguments
      // just mind that this can be highly recursive...
      return fnDef.signatures[0].returnType;
    }
  }
}
