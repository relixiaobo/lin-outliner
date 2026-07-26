import { describe, expect, test } from 'bun:test';
import { isOfficeOwnershipFile, officeOwnershipFileInfo } from '../../src/core/officeFiles';

describe('Office ownership files', () => {
  test('recognizes Office and WPS ownership filenames with document extensions', () => {
    expect(officeOwnershipFileInfo('/Downloads/.~Quarterly review.pptx')).toEqual({
      name: '.~Quarterly review.pptx',
      suggestedName: 'Quarterly review.pptx',
    });
    expect(officeOwnershipFileInfo('C:\\docs\\~$Forecast.xlsx')).toEqual({
      name: '~$Forecast.xlsx',
      suggestedName: 'Forecast.xlsx',
    });
    expect(isOfficeOwnershipFile('~$Draft.docm')).toBe(true);
  });

  test('does not hide ordinary hidden files or similarly named non-Office files', () => {
    expect(officeOwnershipFileInfo('.~notes.txt')).toBeNull();
    expect(officeOwnershipFileInfo('~$budget.csv')).toBeNull();
    expect(officeOwnershipFileInfo('report.pptx')).toBeNull();
    expect(officeOwnershipFileInfo('.~.pptx')).toBeNull();
  });
});
