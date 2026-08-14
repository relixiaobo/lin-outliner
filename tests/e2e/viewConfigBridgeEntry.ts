import {
  entersTable,
  missingDisplayOrderPlan,
  tableDisplayFieldInitialization,
} from '../../src/core/viewConfig';

const helpers = {
  entersTable,
  missingDisplayOrderPlan,
  tableDisplayFieldInitialization,
};

declare global {
  // eslint-disable-next-line no-var
  var __linViewConfigHelpers: typeof helpers | undefined;
}

globalThis.__linViewConfigHelpers = helpers;
