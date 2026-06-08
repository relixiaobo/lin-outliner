// English — the CANONICAL message surface. Its shape defines `Messages` (see
// core/i18n/index.ts); every other locale is a deep-partial of this and falls back
// here for any key it has not translated yet. So: add a key HERE first, then fill it
// into the other locales (the coverage test reports what is still missing).
//
// Static strings are plain string values. Strings with runtime values are arrow
// functions taking a typed params object — this keeps interpolation fully
// type-checked at the call site (t.menu.help({ app }) won't compile without `app`).
//
// This is the PR1 foundation slice (native menu + launcher chrome + the settings
// General pane). Subsequent migration PRs grow this tree surface by surface; see
// docs/plans/i18n-multi-language.md.

export const en = {
  // Native application + context menus (main process; rebuilt on language change).
  menu: {
    settings: 'Settings…',
    about: ({ app }: { app: string }) => `About ${app}`,
    hide: ({ app }: { app: string }) => `Hide ${app}`,
    quit: ({ app }: { app: string }) => `Quit ${app}`,
    file: 'File',
    // Native role-based menus (Edit / Window / Help) and View's standard items are
    // OS-localized by default; we give each an explicit label so the whole bar follows
    // the app's chosen language. `togglefullscreen` keeps its role-only dynamic
    // "Enter/Exit Full Screen" title (a static label would lose the toggle state).
    edit: 'Edit',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    pasteAndMatchStyle: 'Paste and Match Style',
    delete: 'Delete',
    selectAll: 'Select All',
    speech: 'Speech',
    startSpeaking: 'Start Speaking',
    stopSpeaking: 'Stop Speaking',
    view: 'View',
    reload: 'Reload',
    forceReload: 'Force Reload',
    toggleDevTools: 'Toggle Developer Tools',
    resetZoom: 'Actual Size',
    zoomIn: 'Zoom In',
    zoomOut: 'Zoom Out',
    window: 'Window',
    minimize: 'Minimize',
    zoom: 'Zoom',
    front: 'Bring All to Front',
    helpTitle: 'Help',
    help: ({ app }: { app: string }) => `${app} Help`,
    reportIssue: 'Report an Issue…',
    addToDictionary: 'Add to Dictionary',
  },
  // Native window titles (main process).
  window: {
    settingsTitle: ({ app }: { app: string }) => `${app} Settings`,
    providerConfigTitle: 'Configure provider',
    // The native "insert image" file-picker dialog (title + the image filter label).
    insertImageTitle: 'Insert image',
    imageFilesFilter: 'Images',
  },
  // The global launcher's static chrome (placeholder + accessibility labels).
  launcher: {
    placeholder: 'Capture, search, or run a command…',
    queryAriaLabel: 'Launcher query',
    rootAriaLabel: ({ app }: { app: string }) => `${app} Launcher`,
    resultsAriaLabel: 'Results',
    // Result-row action labels (what Enter runs). `captureToToday` takes the
    // provider-aware noun (page / video); nounPage/nounVideo are those nouns.
    actions: {
      nounPage: 'page',
      nounVideo: 'video',
      captureToToday: ({ noun }: { noun: string }) => `Capture ${noun} to Today`,
      newNodeInToday: 'New node in Today',
      open: 'Open',
    },
    // The uniform per-row display (title / subtitle / right-aligned type label).
    rowView: {
      captureTitle: 'Capture',
      newNodeTitle: 'New node',
      // The right-aligned category label on each row.
      typeCommand: 'Command',
      typeNode: 'Node',
      // Fallback for where a capture comes from when no host/app name is known.
      currentPage: 'current page',
      // Capture-row subtitles. `note` arrives already quoted; `·` is the separator.
      captureWithNote: ({ note, where }: { note: string; where: string }) => `+ ${note} · ${where}`,
      captureFromPage: ({ page, where }: { page: string; where: string }) => `${page} · ${where}`,
    },
    // The quiet "saved, but here's how to capture more" banner (Automation denied).
    remediation: {
      // Fallback used in the messages when the browser's name isn't known.
      fallbackBrowser: 'your browser',
      cannotReadTitle: ({ browser }: { browser: string }) => `Can’t read ${browser}`,
      cannotReadDetail: ({ app, browser }: { app: string; browser: string }) =>
        `Allow ${app} to control ${browser} in System Settings → Privacy & Security → Automation, then reopen.`,
    },
    // User-facing capture/save failures shown in the action bar.
    error: {
      saveFailed: 'Save failed.',
      saveFailedRestart: 'Save failed — restart the dev app (main process does not hot-reload).',
    },
    // In-flight save hint shown in place of the primary action label.
    saving: 'Saving…',
    // Empty-state hint when no rows match (idle launcher, no query).
    emptyState: 'Type to capture, search, or run a command.',
  },
  // The settings window: rail chrome, categories, and the General pane.
  settings: {
    providers: {
      connectedGroup: 'Connected',
      connectedAriaLabel: 'Connected providers',
      availableGroup: 'Available',
      availableAriaLabel: 'Available providers',
      addCustom: 'Add custom provider',
      // Row + ⋯ menu actions
      setActive: 'Set as Active',
      configureAction: 'Configure…',
      removeProvider: 'Remove provider',
      configure: 'Configure',
      configureNamed: ({ name }: { name: string }) => `Configure ${name}`,
      rowAriaLabel: ({ name, status }: { name: string; status: string }) => `${name}, ${status}`,
      rowActionsAriaLabel: ({ name }: { name: string }) => `${name} actions`,
      rowMenuAriaLabel: 'Provider actions',
      // Notices after a row mutation
      setActiveNotice: 'Provider set as active',
      removedNotice: 'Provider removed',
      // Trailing status word for the provider row aria-label
      status: {
        ready: 'Ready',
        addKey: 'Add key',
        disabled: 'Disabled',
        needsKey: 'Needs key',
        active: 'Active',
      },
    },
    permissions: {
      sectionAriaLabel: 'Tool Permissions',
      commonActionsGroup: 'Common Actions',
      commonActionsAriaLabel: 'Common actions',
      ignoredRulesGroup: 'Ignored JSON Rules',
      ignoredRulesAriaLabel: 'Ignored JSON rules',
      // Decision dropdown
      decisionAriaLabel: ({ rule }: { rule: string }) => `${rule} permission`,
      askOption: 'Ask first',
      allowOption: 'Always allow',
      deniedOption: 'Denied in JSON',
      // Label + description per common rule, keyed by stable id
      rules: {
        readOutsideArea: {
          label: 'Read outside allowed area',
          description: 'Local reads outside the configured file boundary.',
        },
        readSensitivePaths: {
          label: 'Read sensitive local paths',
          description: 'Credential-like paths such as SSH keys, env files, and package tokens.',
        },
        fetchWeb: {
          label: 'Fetch web pages',
          description: 'Directly contact a URL and read its response.',
        },
        deleteFiles: {
          label: 'Delete local files',
          description: 'Remove files inside the allowed file area.',
        },
        runProjectScripts: {
          label: 'Run project scripts',
          description: 'Execute local validation commands and package scripts.',
        },
        installDependencies: {
          label: 'Install dependencies',
          description: 'Run package manager commands that change dependencies or lockfiles.',
        },
        publishGitRemotes: {
          label: 'Publish to Git remotes',
          description: 'Push commits or mutate GitHub/Git remotes.',
        },
        deployPublish: {
          label: 'Deploy or publish',
          description: 'Publish packages, deployments, or remote environments.',
        },
        networkWrite: {
          label: 'Network write commands',
          description: 'Shell commands that send data outward or mutate network services.',
        },
        spawnSubagents: {
          label: 'Spawn subagents',
          description: 'Start another agent process. Global allow is intentionally unavailable.',
        },
      },
    },
    memory: {
      sectionAriaLabel: 'Agent Memory',
      entriesGroup: 'Remembered Facts',
      entriesAriaLabel: 'Remembered facts',
      loading: 'Loading memory…',
      empty: 'No remembered facts yet.',
      activeStatus: 'Active',
      invalidatedStatus: 'Forgotten',
      createdAt: ({ date }: { date: string }) => `Created ${date}`,
      editFactLabel: 'Memory fact',
      editEntry: 'Edit memory',
      forgetEntry: 'Forget memory',
      saveEdit: 'Save memory',
      cancelEdit: 'Cancel memory edit',
      updatedNotice: 'Memory updated',
      forgottenNotice: 'Memory forgotten',
      emptyFactError: 'Memory fact cannot be empty.',
      notFoundError: 'Memory entry no longer exists.',
    },
    skills: {
      sectionAriaLabel: 'Skills & Behaviors',
      behaviorRulesGroup: 'Behavior Rules',
      behaviorRulesAriaLabel: 'Behavior rules',
      automaticSkillsLabel: 'Automatic Skills',
      automaticSkillsSublabel: 'Allow agent to autonomously invoke skills to solve tasks.',
      slashSkillsLabel: 'Slash Skills',
      slashSkillsSublabel: 'Enable users to directly invoke skills in chat via slash commands.',
      compactLabel: 'Compact Command',
      compactSublabel: 'Enable automatic conversation context compaction when token budget runs low.',
      loadingInstalled: 'Loading installed skills…',
      noneInstalled: 'No skills installed in ~/.agents/skills or .agents/skills.',
      installedGroup: 'Installed Capabilities',
      installedAriaLabel: 'Installed capabilities',
      toggleSkill: ({ name }: { name: string }) => `Toggle ${name}`,
    },
    agents: {
      sectionAriaLabel: 'Agent Profiles',
      profilesAriaLabel: 'Agent profiles',
      loadingProfiles: 'Loading profiles…',
      noneFound: 'No agent definitions found.',
      toggleAgent: ({ name }: { name: string }) => `Toggle ${name}`,
      detailAriaLabel: ({ name }: { name: string }) => `${name} profile details`,
      detailOptionsAriaLabel: ({ name }: { name: string }) => `${name} profile options`,
      enabledLabel: 'Enabled',
      enabledSublabel: 'Allow this profile to be used for subagent runs.',
      personaPromptLabel: 'Persona prompt (System instructions)',
      modelOverride: 'Model Override',
      thinkingLevel: 'Thinking Level',
      permissionMode: 'Permission Mode',
      restricted: 'Restricted',
      maxTurns: 'Max Turns',
      profileNotFound: 'Agent profile not found.',
      newAgent: 'New agent',
      createTitle: 'New agent',
      editTitle: ({ name }: { name: string }) => `Edit ${name}`,
      nameLabel: 'Name',
      namePlaceholder: 'my-agent',
      descriptionLabel: 'Description',
      descriptionPlaceholder: 'What this agent is for',
      personaPlaceholder: 'You are a focused subagent…',
      scaffoldBody: 'You are a focused subagent.\nComplete the task and report only the result.',
      modelPlaceholder: 'inherit',
      effortDefault: 'Inherit',
      permissionInherit: 'Inherit',
      trusted: 'Trusted',
      maxTurnsPlaceholder: 'unlimited',
      modeLabel: 'Editor mode',
      modeForm: 'Form',
      modeRaw: 'Raw',
      rawLabel: 'AGENT.md',
      toolsLabel: 'Tools',
      toolsSublabel: 'Unchecked tools are withheld from this agent.',
      toolsAllEnabled: 'All tools enabled — no restriction.',
      toggleTool: ({ name }: { name: string }) => `Toggle ${name}`,
      skillsLabel: 'Skills',
      skillsSublabel: 'Skills this agent can load.',
      skillsEmpty: 'No skills installed.',
      toggleSkill: ({ name }: { name: string }) => `Toggle ${name}`,
      backgroundLabel: 'Run in background',
      backgroundSublabel: 'Start without blocking the parent and report when done.',
      storageLabel: 'Storage location',
      storageUser: 'Global (~/.agents)',
      storageProject: 'Workspace (.agents)',
      saveAgent: 'Save',
      createAgent: 'Create',
      deleteAgent: 'Delete',
      duplicateToMine: 'Duplicate to my agents',
      deleteConfirm: ({ name }: { name: string }) => `Delete agent “${name}”? This removes its AGENT.md.`,
      builtInReadOnly: 'Built-in agents are read-only. Duplicate to create an editable copy.',
      nameRequired: 'Enter an agent name.',
      createdNotice: 'Agent created.',
      savedAgentNotice: 'Agent saved.',
      deletedNotice: 'Agent deleted.',
      duplicatedNotice: 'Agent duplicated.',
      directoriesGroup: 'Agent directories',
      directoriesLabel: 'Additional agent directories',
      directoriesSublabel: 'Comma-separated paths scanned for extra agents.',
      directoriesPlaceholder: '~/my-agents, ./team-agents',
    },
    footer: {
      cancel: 'Cancel',
      save: 'Save',
      saving: 'Saving...',
      savedNotice: 'Saved',
    },
    navigation: {
      back: 'Back',
      forward: 'Forward',
    },
    // Reasoning-level display names (Off / Minimal / … / XHigh). NOTE: currently the
    // only consumer in scope (settingsReasoning.ts REASONING_LABELS) is dead code; a
    // later consolidation pass can point the live composer menu at these.
    reasoning: {
      off: 'Off',
      minimal: 'Minimal',
      low: 'Low',
      medium: 'Medium',
      high: 'High',
      xhigh: 'XHigh',
    },
    railTitle: 'Settings',
    loading: 'Loading…',
    categoriesAriaLabel: 'Settings categories',
    categories: {
      general: { label: 'General', hint: 'Appearance & Theme' },
      providers: { label: 'Providers', hint: 'Connections & API keys' },
      permissions: { label: 'Permissions', hint: 'Tool Allow / Ask Rules' },
      memory: { label: 'Memory', hint: 'Remembered Facts' },
      skills: { label: 'Skills', hint: 'Extension Capabilities' },
      agents: { label: 'Agent Profiles', hint: 'Persona Definitions' },
    },
    general: {
      appearanceGroup: 'Appearance',
      themeLabel: 'Theme',
      themeSublabel: 'Match the system appearance, or always use light or dark.',
      themeSystem: 'System',
      themeLight: 'Light',
      themeDark: 'Dark',
      languageLabel: 'Language',
      languageSublabel: 'Choose the display language for menus and the interface.',
      notificationsGroup: 'Notifications',
      osNotificationsLabel: 'System notifications',
      osNotificationsSublabel: 'Show a system notification when a background task finishes or needs input while the app is in the background. Off by default.',
    },
  },
  // Cross-surface shared atoms — declared once so the same word has one key and one
  // translation everywhere (avoids divergent 'Untitled' / 'Loading…' per surface).
  common: {
    untitled: 'Untitled',
    loading: 'Loading…',
  },
  // The always-visible app shell: window chrome, sidebar, workspace canvas, panels,
  // and the agent dock frame (B1 migration).
  shell: {
    startupError: ({ error }: { error: string }) => `Startup failed: ${error}`,
    errorDismiss: 'Dismiss error',
    sidebar: {
      ariaLabel: 'Primary navigation',
      primaryNav: {
        today: 'Today',
        library: 'Library',
        recents: 'Recents',
        schema: 'Schema',
      },
      collapseNode: ({ label }: { label: string }) => `Collapse ${label}`,
      expandNode: ({ label }: { label: string }) => `Expand ${label}`,
      pinnedSection: 'Pinned',
      noPinnedHint: 'Drag to pin nodes',
      pinnedNodesAriaLabel: 'Pinned nodes',
      openRoot: ({ rootLabel }: { rootLabel: string }) => `Open ${rootLabel}`,
      workspaceRootTreeAriaLabel: 'Workspace root tree',
      settings: 'Settings',
      resizeLabel: 'Resize sidebar',
      resizeTitle: 'Resize sidebar (double-click to reset)',
      missingReference: 'Missing reference',
    },
    chrome: {
      collapseSidebar: 'Collapse sidebar',
      expandSidebar: 'Expand sidebar',
      collapseAgent: 'Collapse agent',
      expandAgent: 'Expand agent',
    },
    workspace: {
      canvasAriaLabel: 'Workspace canvas',
      resizePanelsLabel: 'Resize panels',
      resizePanelsTitle: 'Resize panels (double-click to reset)',
    },
    panel: {
      closeLabel: 'Close panel',
    },
    agentDock: {
      ariaLabel: 'Agent',
      resizeLabel: 'Resize agent',
      resizeTitle: 'Resize agent (double-click to reset)',
    },
  },
  // The node panel header: breadcrumb, page title, and the more-actions /
  // search-query toggle controls.
  nodePanel: {
    previousPage: 'Previous page',
    openLibrary: 'Open library',
    breadcrumbAriaLabel: 'Panel breadcrumb',
    // Collapse only fires with multiple hidden levels, so this is never "1 level"
    // in practice; left un-pluralized to match prior behavior. // TODO plural via Intl
    showHiddenBreadcrumbLevels: ({ count }: { count: number }) => `Show ${count} hidden breadcrumb levels`,
    showHiddenBreadcrumbLevelsTitle: 'Show hidden breadcrumb levels',
    closePanel: 'Close panel',
    pageTitleAriaLabel: 'Page title',
    moreActionsLabel: 'More node actions',
    moreActionsTitle: 'More',
    showQuery: 'Show query',
    hideQuery: 'Hide query',
  },
  // The day-panel date navigation strip (prev/next/today + calendar popover).
  dateNavigation: {
    ariaLabel: 'Date navigation',
    previousDay: 'Previous day',
    nextDay: 'Next day',
    today: 'Today',
    openCalendar: 'Open calendar',
    calendarDialogAriaLabel: 'Calendar',
    goToDate: ({ isoDate }: { isoDate: string }) => `Go to ${isoDate}`,
    // TODO plural via Intl — keep the n===1 ternary in English only.
    goToDateWithCount: ({ isoDate, count }: { isoDate: string; count: number }) =>
      `Go to ${isoDate} · ${count} ${count === 1 ? 'node' : 'nodes'}`,
  },
  // Date display vocabulary: short weekday/month names and the humanized,
  // relative day-node title ("Today, Wed, May 27"). Used to render a locked day
  // node's ISO date as a friendly label.
  dateFormat: {
    // Sunday-first, indexed directly by `Date.getDay()` (Sun=0). Intentionally a
    // different shape from `calendar.weekdayInitials` (Monday-first single letters for
    // the mini-calendar header) — not a duplicate source. Both are length-guarded by
    // tests/core/i18nCoverage and TODO: derive from Intl.DateTimeFormat per locale.
    weekdaysShort: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    monthsShort: [
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
    ],
    dayName: ({ weekday, month, day }: { weekday: string; month: string; day: number }) =>
      `${weekday}, ${month} ${day}`,
    today: ({ dayName }: { dayName: string }) => `Today, ${dayName}`,
    tomorrow: ({ dayName }: { dayName: string }) => `Tomorrow, ${dayName}`,
    yesterday: ({ dayName }: { dayName: string }) => `Yesterday, ${dayName}`,
  },

commandPalette: {
  // Dialog + input
  dialogLabel: 'Command palette',
  inputLabel: 'Search or create',
  inputPlaceholder: 'Search or create',
  // Group headings
  headingNavigate: 'Navigate',
  headingNodes: 'Nodes',
  // Type labels (right-aligned meta on each row)
  typeNavigate: 'Navigate',
  typeNode: 'Node',
  typeNewInToday: 'New in Today',
  // Navigation targets
  navToday: 'Today',
  navLibrary: 'Library',
  navSchema: 'Schema',
  navSavedSearches: 'Saved searches',
  navTrash: 'Trash',
  // Action-bar verbs
  actionCreate: 'Create',
  actionOpen: 'Open',
  // Dynamic: create-from-query row label
  createLabel: ({ label }: { label: string }) => `Create "${label}"`,
},

  // The center outline: the per-view toolbar (display/group/sort/filter), the
  // node right-click context menu, read-only system-field values, and field-value
  // editing chrome (pickers, popovers, date picker, code block, images).
  outliner: {
    // The view toolbar above a node's children: display fields, group-by, sort
    // rules, and the progressive filter editor.
    viewToolbar: {
      toolbarAriaLabel: 'View toolbar',
      display: 'Display',
      groupBy: 'Group by',
      sortBy: 'Sort by',
      filterBy: 'Filter by',
      thenBy: 'Then by',
      noGrouping: 'No grouping',
      reset: 'Reset',
      remove: 'Remove',
      removeSortRule: 'Remove sort rule',
      removeFilterRule: 'Remove filter rule',
      removeFilter: 'Remove filter',
      addSort: 'Add sort',
      addingFilter: 'Adding filter…',
      sortFieldLabel: 'Sort field',
      filterOperatorLabel: 'Filter operator',
      filterDateLabel: 'Filter date',
      filterValuesLabel: 'Filter values',
      filterValuePlaceholder: 'value',
      filterFieldPlaceholder: 'Filter field',
      noMatchingFields: 'No matching fields',
      noOptions: 'No options',
      fieldFallback: 'Field',
      // Sort-direction labels read in the field's own terms (A→Z, 1→9, Old→New).
      sortAlphaAsc: 'A → Z',
      sortAlphaDesc: 'Z → A',
      sortNumberAsc: '1 → 9',
      sortNumberDesc: '9 → 1',
      sortDateAsc: 'Old → New',
      sortDateDesc: 'New → Old',
      sortBooleanAsc: 'Unchecked → Checked',
      sortBooleanDesc: 'Checked → Unchecked',
      // Filter operators.
      operatorContains: 'Contains',
      operatorNotContains: 'Does not contain',
      operatorIs: 'Is',
      operatorIsNot: 'Is not',
      operatorIsEmpty: 'Is empty',
      operatorIsNotEmpty: 'Is not empty',
      operatorGreaterThan: 'Greater than',
      operatorLessThan: 'Less than',
      operatorAfter: 'After',
      operatorBefore: 'Before',
      // Boolean filter choices (Done field reads as Done/Not done).
      booleanDone: 'Done',
      booleanNotDone: 'Not done',
      booleanYes: 'Yes',
      booleanNo: 'No',
      // The muted one-line summary of the active view.
      summaryGroupedBy: ({ field }: { field: string }) => `Grouped by ${field}`,
      summarySortedBy: ({ field, arrow }: { field: string; arrow: string }) => `Sorted by ${field} ${arrow}`,
      // TODO plural via Intl
      summaryFilterCount: (count: number) => `${count} filter${count > 1 ? 's' : ''}`,
    },
    // Read-only system field values (Done checkbox, date, tag badges, text).
    systemField: {
      done: 'Done',
      notDone: 'Not done',
      openTag: ({ label }: { label: string }) => `Open ${label}`,
    },
    // The node right-click context menu (main actions + tag / move submodes).
    contextMenu: {
      nodeActions: 'Node actions',
      openInSplitPane: 'Open in split pane',
      moveTo: 'Move to',
      moveNode: 'Move node',
      back: 'Back',
      // `prefix` carries the batch-selection label (e.g. "3 nodes · "); empty for
      // a single node.
      duplicate: ({ prefix }: { prefix: string }) => `${prefix}Duplicate`,
      moveUp: ({ prefix }: { prefix: string }) => `${prefix}Move up`,
      moveDown: ({ prefix }: { prefix: string }) => `${prefix}Move down`,
      toggleDone: ({ prefix }: { prefix: string }) => `${prefix}Toggle done`,
      markDonePrefixed: ({ prefix }: { prefix: string }) => `${prefix}Mark done`,
      markNotDonePrefixed: ({ prefix }: { prefix: string }) => `${prefix}Mark not done`,
      addTag: ({ prefix }: { prefix: string }) => `${prefix}Add tag`,
      trash: ({ prefix }: { prefix: string }) => `${prefix}Trash`,
      restore: 'Restore',
      hideViewToolbar: 'Hide view toolbar',
      showViewToolbar: 'Show view toolbar',
      filterBy: 'Filter by',
      sortBy: 'Sort by',
      groupBy: 'Group by',
      display: 'Display',
      addDescription: 'Add description',
      editDescription: 'Edit description',
      copyText: 'Copy text',
      copyNodeId: 'Copy node id',
      // Tag submode + the batch tag selector.
      addTagTitle: 'Add tag',
      tagNameLabel: 'Tag name',
      tagNamePlaceholder: 'tag name',
      searchOrCreateTag: 'Search or create tag',
      noTags: 'No tags',
      // TODO plural via Intl
      applyTagToNodes: (count: number) => `Apply tag to ${count} node${count > 1 ? 's' : ''}`,
      // Move submode.
      nodeNameLabel: 'Node name',
      nodeNamePlaceholder: 'node name',
      // Shared Done labels (also used by the lone Done checkbox control).
      markDone: 'Mark done',
      markNotDone: 'Mark not done',
    },
    // Field-value editing chrome: row markers, descriptions, the field-name input,
    // typed-value placeholders, and the option / reference / slash trigger pickers.
    field: {
      // Row leading / indent affordances.
      collapse: 'Collapse',
      expand: 'Expand',
      open: 'Open',
      openField: 'Open field',
      toggleChildren: 'Toggle children',
      descriptionPlaceholder: 'Description',
      // Field-name input + typed-value placeholders.
      fieldNameLabel: 'Field name',
      fieldNameTitle: ({ name, type }: { name: string; type: string }) => `${name} (${type})`,
      systemFieldTitle: ({ name }: { name: string }) => `${name} (System field)`,
      selectOption: 'Select option',
      empty: 'Empty',
      datePlaceholder: 'Press Space to pick a date…',
      referencePlaceholder: 'Search for a node to reference…',
      fieldValueAriaLabel: 'Field value',
      // Boolean (checkbox) whole-field control.
      booleanYes: 'Yes',
      booleanNo: 'No',
      // Field-name reuse popover.
      reuseFieldLabel: 'Reuse field',
      noMatchingFields: 'No matching fields',
      // Field-value affordances + the selected-reference option picker.
      openLink: 'Open link',
      pickADate: 'Pick a date',
      selectedFieldOptions: 'Selected field options',
      // Option-value popover (optionPicker draft).
      fieldOptionsLabel: 'Field options',
      noOptions: 'No options',
      createOption: ({ label }: { label: string }) => `Create "${label}"`,
      // Reference picker / @ trigger.
      referenceSuggestions: 'Reference suggestions',
      noMatches: 'No matches',
      createReference: ({ label }: { label: string }) => `Create "${label}"`,
      // Date shortcuts shown at the top of the reference (@) picker.
      referenceDateToday: 'Today',
      referenceDateTomorrow: 'Tomorrow',
      referenceDateYesterday: 'Yesterday',
      // # / / triggers.
      tagSuggestions: 'Tag suggestions',
      slashCommands: 'Slash commands',
      noCommands: 'No commands',
      // Slash-command menu item labels (keyed by command id; keywords stay English
      // for matching). Brand/format terms aren't translated.
      slashLabels: {
        field: 'Field',
        reference: 'Reference',
        heading: 'Heading',
        checkbox: 'Checkbox',
        code: 'Code block',
        image: 'Image',
        command_palette: 'Command palette',
      },
      // Image block toolbar + missing state.
      image: {
        unavailable: 'Image unavailable',
        addCaption: 'Add caption',
        editCaption: 'Edit caption',
        expand: 'Expand image',
        openOriginal: 'Open original',
        openInBrowser: 'Open in browser',
      },
      // Code block chrome.
      code: {
        languageLabel: 'Code language',
        copyCode: 'Copy code',
        // Label shown when a code block has no (or an unrecognized) language set.
        plainText: 'Plain text',
      },
      // Field-value date picker overlay.
      datePicker: {
        title: 'Date picker',
        start: 'Start',
        end: 'End',
        startDate: 'Start date',
        startTime: 'Start time',
        endDate: 'End date',
        endTime: 'End time',
        endDateToggle: 'End date',
        includeTimeToggle: 'Include time',
        today: 'Today',
        clear: 'Clear',
      },
      // Generic node value picker (NodeValuePicker) defaults.
      valuePicker: {
        clearSelection: 'Clear selection',
        noOptions: 'No options',
        create: ({ label }: { label: string }) => `Create "${label}"`,
        optionsListLabel: ({ name }: { name: string }) => `${name} options`,
      },
    },
  },

  // Supertag / field definition configuration panel: the per-row labels, the
  // hide-field / auto-initialize option sets, control placeholders, and the
  // definition outliner section headings.
  definition: {
    panel: {
      ariaLabel: 'Definition configuration',
    },
    // Row labels for a supertag definition's config (left-hand name column).
    tagConfig: {
      color: 'Color',
      extends: 'Extend from',
      showCheckbox: 'Show as checkbox',
      doneStateEnabled: 'Done state mapping',
      doneMapChecked: 'When done, set',
      doneMapUnchecked: 'When not done, set',
      childSupertag: 'Default child supertag',
    },
    // Row labels for a field definition's config.
    fieldConfig: {
      fieldType: 'Field type',
      sourceSupertag: 'Supertag',
      autocollectOptions: 'Auto-collect values',
      autoInitialize: 'Auto-initialize',
      required: 'Required',
      hideField: 'Hide field',
      minValue: 'Minimum value',
      maxValue: 'Maximum value',
    },
    // "Hide field" mode options. Keys mirror the HideFieldMode union values.
    hideFieldOptions: {
      never: 'Never',
      empty: 'When empty',
      not_empty: 'When not empty',
      value_is_default: 'When default',
      always: 'Always',
    },
    // Auto-initialize strategy toggles.
    autoInit: {
      currentDate: 'Current date',
      ancestorDayNode: 'Ancestor day node',
      ancestorFieldValue: 'Ancestor field value',
      ancestorSupertagRef: 'Ancestor with source supertag',
    },
    // Shared control vocabulary.
    controls: {
      none: 'None',
      yes: 'Yes',
      no: 'No',
      noColor: 'No color',
      fieldFallback: 'Field',
    },
    doneMapping: {
      empty: 'Add an options field to map its done state.',
    },
    // Headings shown above the definition's editable outliner body.
    outliner: {
      defaultContent: 'Default content',
      predeterminedOptions: 'Pre-determined options',
      // Empty-state call-to-action on the block's trailing draft row.
      defaultContentPlaceholder: 'Add default content…',
      predeterminedOptionsPlaceholder: 'Add an option…',
    },
  },

  // Shared confirm/cancel dialog defaults (ConfirmDialog primitive).
  dialog: {
    confirm: 'Confirm',
    cancel: 'Cancel',
  },
  // The month-grid date picker primitive (CalendarMonthGrid): nav arrows, the
  // weekday header initials, and the per-day cell accessible name.
  calendar: {
    previousMonth: 'Previous month',
    nextMonth: 'Next month',
    // Single-letter weekday initials, Monday-first, rendered as the (aria-hidden)
    // mini-calendar column header. TODO: derive from Intl.DateTimeFormat for the
    // active locale instead of a hardcoded list.
    weekdayInitials: ['M', 'T', 'W', 'T', 'F', 'S', 'S'],
    // isoDate is a 'YYYY-MM-DD' mask — keep verbatim, do not translate.
    selectDate: ({ isoDate }: { isoDate: string }) => `Select ${isoDate}`,
  },

  // The agent chat surface: transcript, composer, message rows, process/tool-call
  // blocks, subagent details, thinking blocks, and markdown rendering.
  agent: {
    // The chat panel header + conversation history menu.
    chat: {
      // Empty conversation state: blank when a provider is connected, else the
      // connect-a-provider onboarding (gated on loaded provider settings).
      onboardingText: 'Connect an AI provider to start.',
      onboardingCta: 'Open Settings › Providers',
      showConversations: 'Show channels',
      newConversation: 'New channel',
      openDebug: 'Open agent debug',
      conversations: 'Channels',
      noConversations: 'No channels',
      unreadTasks: ({ count }: { count: number }) =>
        count === 1 ? '1 unread task update' : `${count} unread task updates`,
      conversationTitle: 'Channel name',
      cancelRename: 'Cancel rename',
      saveRename: 'Save rename',
      renameConversation: 'Rename channel',
      rename: 'Rename',
      deleteConversation: 'Delete channel',
      delete: 'Delete',
      cancel: 'Cancel',
      deleteConfirmTitle: 'Delete channel?',
      deleteConfirmMessage: ({ title }: { title: string }) =>
        `"${title}" will be permanently deleted. This cannot be undone.`,
    },
    // The composer: editor, toolbar, model menu, attachment + approval flows.
    composer: {
      editorAriaLabel: 'Agent message',
      askPlaceholder: 'Ask anything...',
      steerPlaceholder: 'Steer the conversation...',
      appendSteerPlaceholder: 'Append another steer...',
      dropFilesToAttach: 'Drop files to attach',
      addAttachment: 'Add attachment',
      selectModel: 'Select model',
      noModelConfigured: 'No model configured',
      moreModels: 'More models',
      thinking: 'Thinking',
      thinkingLevel: 'Thinking level',
      thinkingLevels: 'Thinking levels',
      modelAndReasoningSettings: 'Model and reasoning settings',
      // Reasoning effort levels shown on the model menu + reasoning chip.
      reasoningLevels: {
        off: 'Off',
        minimal: 'Minimal',
        low: 'Low',
        medium: 'Medium',
        high: 'High',
        max: 'Max',
      },
      editQueuedSteer: 'Edit queued steer',
      cancelQueuedSteer: 'Cancel queued steer',
      send: 'Send',
      sendMessage: 'Send message',
      steerAgent: 'Steer agent',
      stop: 'Stop',
      stopAgent: 'Stop agent',
      // Approval card.
      showDetails: 'Show details',
      hideDetails: 'Hide details',
      alwaysAllowRule: 'Always allow rule',
      approveOnce: 'Approve once',
      alwaysAllow: 'Always allow',
      denyOnce: 'Deny once',
      userQuestionTitle: 'Input needed',
      userQuestionSubmit: 'Submit answer',
      userQuestionAnswerPlaceholder: 'Type your answer...',
      userQuestionOtherPlaceholder: 'Other...',
      // Mention / slash popovers.
      slashCommandsLabel: 'Agent slash commands',
      mentionSuggestionsLabel: 'Agent mention suggestions',
      noCommands: 'No commands',
      searchingFiles: 'Searching files...',
      couldNotSearchFiles: 'Could not search files',
      noMentions: 'No mentions',
      noRecentMentions: 'No recent mentions',
      // Attachment errors.
      attachmentsCannotQueue: 'Attachments cannot be queued while the agent is running.',
      localFileSearchUnavailable: 'Local file search is not available in this window.',
      localFileNoLongerAvailable: 'That local file is no longer available.',
      maxAttachments: ({ max }: { max: number }) => `You can attach up to ${max} files.`,
      // TODO plural via Intl
      skippedDuplicates: ({ count }: { count: number }) =>
        count === 1
          ? "Skipped 1 file that's already attached."
          : `Skipped ${count} files that are already attached.`,
      // TODO plural via Intl
      skippedOverflow: ({ count, max }: { count: number; max: number }) =>
        count === 1
          ? `Skipped 1 file over the ${max} attachment limit.`
          : `Skipped ${count} files over the ${max} attachment limit.`,
    },
    filePreview: {
      file: 'File',
      folder: 'Folder',
      modified: ({ date }: { date: string }) => `Modified ${date}`,
      unavailable: 'File unavailable',
    },
    // Message-row actions + shared message atoms.
    message: {
      assistantResponding: 'Assistant is responding',
      referencedNode: 'Referenced node',
      previousBranch: 'Previous branch',
      nextBranch: 'Next branch',
      showPreviousBranch: 'Show previous branch',
      showNextBranch: 'Show next branch',
      cancel: 'Cancel',
      cancelEdit: 'Cancel edit',
      save: 'Save',
      saveEdit: 'Save edit',
      edit: 'Edit',
      editMessage: 'Edit message',
      copy: 'Copy',
      copyMessage: 'Copy message',
      showMore: 'Show more',
      showLess: 'Show less',
      retry: 'Retry',
      retryResponse: 'Retry response',
      regenerate: 'Regenerate',
      regenerateResponse: 'Regenerate response',
    },
    // The collapsible thinking/tool process block + compaction boundary.
    process: {
      working: 'Working...',
      interrupted: 'Interrupted',
      interruptedAfterThinking: 'Interrupted after thinking',
      thoughtInterrupted: 'Thought (interrupted)',
      thought: 'Thought',
      thoughtPreview: ({ preview }: { preview: string }) => `Thought · ${preview}`,
      thoughtAndTool: ({ tool }: { tool: string }) => `Thought · ${tool}`,
      usedTools: ({ count }: { count: number }) => `Used ${count} tools`,
      thoughtAndUsedTools: ({ count }: { count: number }) => `Thought · used ${count} tools`,
      compactingConversation: 'Compacting conversation',
      conversationCompacted: 'Conversation compacted',
      compacting: 'Compacting',
      compacted: 'Compacted',
      compactionTrigger: {
        manual: 'Manual',
        auto: 'Auto',
        retry: 'Retry',
      },
      dreamingMemory: 'Dreaming memory',
      memoryDreamed: 'Memory Dream',
      dreaming: 'Dreaming',
      dreamed: 'Dreamed',
      dreamFailed: 'Dream failed',
      dreamSkipped: 'Dream skipped',
      dreamTrigger: {
        manual: 'Manual',
        schedule: 'Scheduled',
      },
      dreamProcessedMessages: ({ count }: { count: number }) => `${count} ${count === 1 ? 'message' : 'messages'}`,
      dreamMemoryChanges: ({ count }: { count: number }) => `${count} memory ${count === 1 ? 'change' : 'changes'}`,
      dreamProcessedDetail: ({ messages, chars }: { messages: number; chars: number }) =>
        `Processed ${messages} ${messages === 1 ? 'message' : 'messages'} (${chars.toLocaleString()} chars).`,
      dreamChangesDetail: ({ added, updated, forgotten, skipped }: { added: number; updated: number; forgotten: number; skipped: number }) =>
        `Memory changes: ${added} added, ${updated} updated, ${forgotten} forgotten, ${skipped} skipped.`,
    },
    // Tool-call disclosure: summaries (verb forms), section headers, persisted output.
    toolCall: {
      input: 'Input',
      output: 'Output',
      errorBadge: 'error',
      copyInput: 'Copy tool input',
      copyOutput: 'Copy tool output',
      copyFullOutput: 'Copy full tool output',
      screenshotCaptured: 'Screenshot captured',
      storedOutput: 'Stored tool output',
      payloadUnavailable: 'Payload unavailable',
      loadFullOutput: 'Load full output',
      reloadFullOutput: 'Reload full output',
      windowed: 'Windowed',
      charsOmitted: ({ count }: { count: string }) => `[... ${count} chars omitted ...]`,
      resultImageAlt: ({ index }: { index: number }) => `Tool result ${index}`,
      quote: ({ text }: { text: string }) => `"${text}"`,
      failed: ({ verb }: { verb: string }) => `Failed to ${verb}`,
      withSubject: ({ verb, subject }: { verb: string; subject: string }) => `${verb} ${subject}`,
      under: ({ verb, subject }: { verb: string; subject: string }) => `${verb} under ${subject}`,
      unknownPending: ({ name }: { name: string }) => `${name}...`,
      // Verb triples per tool: base (used in "Failed to {base}"), pending, done.
      verbs: {
        runSubagent: { base: 'run subagent', pending: 'Running subagent', done: 'Ran subagent' },
        checkSubagent: { base: 'check subagent', pending: 'Checking subagent', done: 'Checked subagent' },
        messageSubagent: { base: 'message subagent', pending: 'Messaging subagent', done: 'Messaged subagent' },
        stopSubagent: { base: 'stop subagent', pending: 'Stopping subagent', done: 'Stopped subagent' },
        recallMemory: { base: 'recall memory', pending: 'Recalling memory', done: 'Recalled memory' },
        dreamMemory: { base: 'dream memory', pending: 'Dreaming memory', done: 'Dreamed memory' },
        createNode: { base: 'create node', pending: 'Creating node', done: 'Created node' },
        readNode: { base: 'read node', pending: 'Reading node', done: 'Read node' },
        editNode: { base: 'edit node', pending: 'Editing node', done: 'Edited node' },
        deleteNode: { base: 'delete node', pending: 'Deleting node', done: 'Deleted node' },
        searchNodes: { base: 'search nodes', pending: 'Searching nodes', done: 'Searched nodes' },
        searchWeb: { base: 'search web', pending: 'Searching web', done: 'Searched web' },
        fetchWeb: { base: 'fetch web', pending: 'Fetching web', done: 'Fetched web' },
        runBash: { base: 'run bash', pending: 'Running bash', done: 'Ran bash' },
        editFile: { base: 'edit file', pending: 'Editing file', done: 'Edited file' },
      },
    },
    // The subagent details panel + inline subagent details.
    subagent: {
      summary: ({ description }: { description: string }) => `Subagent · ${description}`,
      heading: 'Subagent',
      status: 'Status',
      mode: 'Mode',
      messages: 'Messages',
      duration: 'Duration',
      name: 'Name',
      prompt: 'Prompt',
      result: 'Result',
      error: 'Error',
      copyPrompt: 'Copy subagent prompt',
      copyResult: 'Copy subagent result',
      copyError: 'Copy subagent error',
      copyId: 'Copy subagent id',
      viewTranscript: 'View transcript',
      transcriptUnavailable: 'Transcript unavailable',
      noResultYet: 'No result yet.',
      roleSystem: 'system',
      roleUser: 'user',
      roleAssistant: 'assistant',
      roleToolResult: 'tool result',
      thoughtNumbered: ({ index }: { index: number }) => `Thought ${index}`,
      transcriptNotAvailable: 'Transcript is not available for this run.',
      loadingTranscript: 'Loading transcript...',
      retry: 'Retry',
      noTranscriptMessages: 'No transcript messages captured yet.',
      transcriptPayloadUnavailable: 'Transcript payload is unavailable.',
      detailsAriaLabel: 'Subagent details',
      detailTabsAriaLabel: 'Subagent detail tabs',
      actionsAriaLabel: 'Subagent actions',
      followUpAriaLabel: 'Subagent follow-up',
      followUpPlaceholder: 'Send follow-up to this subagent',
      closeDetails: 'Close subagent details',
      close: 'Close',
      metaLine: ({ mode, type, count, duration }: { mode: string; type: string; count: number; duration: string }) =>
        `${mode} · ${type} · ${count} messages · ${duration}`,
      tabTimeline: ({ count }: { count: number }) => `Timeline (${count})`,
      tabResult: 'Result',
      tabMetadata: 'Metadata',
      stop: 'Stop',
      stopping: 'Stopping...',
      send: 'Send',
      sending: 'Sending...',
      metaAgentId: 'Agent ID',
      metaType: 'Type',
      metaParentToolCall: 'Parent tool call',
      metaTranscriptPayload: 'Transcript payload',
      metaStarted: 'Started',
      metaUpdated: 'Updated',
      metaNone: 'none',
    },
    task: {
      heading: 'Tasks',
      panelAriaLabel: 'Agent tasks',
      openPanel: 'Open task panel',
      openPanelActive: ({ count }: { count: number }) =>
        count === 1 ? 'Open task panel (1 running)' : `Open task panel (${count} running)`,
      closePanel: 'Close task panel',
      close: 'Close',
      idleSummary: 'No running tasks',
      runningSummary: ({ count }: { count: number }) => count === 1 ? '1 task running' : `${count} tasks running`,
      empty: 'No tasks yet.',
      kindSubagent: 'Subagent',
      kindDream: 'Dream',
      dreamTitle: 'Memory Dream',
      triggerManual: 'Manual',
      triggerSchedule: 'Scheduled',
      openTask: 'Open task',
      stopTask: 'Stop task',
      stopping: 'Stopping...',
      messages: ({ count }: { count: number }) => count === 1 ? '1 message' : `${count} messages`,
      memoryChanges: ({ count }: { count: number }) => count === 1 ? '1 memory change' : `${count} memory changes`,
      status: {
        running: 'Running',
        completed: 'Completed',
        failed: 'Failed',
        stopped: 'Stopped',
      },
    },
    thinking: {
      thinking: 'Thinking...',
    },
    markdown: {
      copyCode: 'Copy code',
      codeLanguageFallback: 'text',
    },
  },

  providerConfig: {
    activeChip: 'Active',
    learnMore: 'Learn more',
    providerIdLabel: 'Provider ID',
    providerIdPlaceholder: 'my-provider',
    apiKeyLabel: 'API key',
    apiKeySavedPlaceholder: 'Saved (encrypted) — paste to replace',
    apiKeyPlaceholder: 'Paste API key',
    showKey: 'Show key',
    hideKey: 'Hide key',
    modelLabel: 'Model',
    modelPlaceholder: 'Model ID',
    baseUrlLabel: 'Base URL',
    getApiKey: 'Get API key',
    validating: 'Validating…',
    cancel: 'Cancel',
    connectionSuccessful: 'Connection successful',
    validationFailed: 'Validation failed',
    removeProvider: 'Remove provider',
    setActive: 'Set as Active',
    validate: 'Validate',
    save: 'Save',
    saving: 'Saving…',
  },
  // The per-provider OAuth sign-in surface (Anthropic / GitHub Copilot / OpenAI Codex).
  providerOAuth: {
    activeChip: 'Active',
    connected: 'Connected',
    accessRenews: ({ when }: { when: string }) => `Access renews ${when}`,
    enterCodeAtSignIn: 'Enter this code at the sign-in page:',
    expiresIn: ({ time }: { time: string }) => `Expires in ${time}`,
    continueInBrowser: 'Continue in your browser to finish signing in.',
    openSignInPage: 'Open the sign-in page',
    waitingForAuthorization: 'Waiting for authorization…',
    pasteCodeLabel: 'Paste the code from your browser',
    authorizationCodePlaceholder: 'Authorization code',
    continue: 'Continue',
    learnMore: 'Learn more',
    signOut: 'Sign out',
    setActive: 'Set as Active',
    useApiKeyInstead: 'Use an API key instead',
    cancelSignIn: 'Cancel sign-in',
    reauthenticate: 'Re-authenticate',
    done: 'Done',
    cancel: 'Cancel',
    signInTo: ({ provider }: { provider: string }) => `Sign in to ${provider}`,
  },
  // Provider catalog copy: descriptions, custom-provider label, and the
  // managed-credential / oauth notes keyed by provider id (brand names verbatim).
  providerCatalog: {
    customProvider: 'Custom provider',
    openAiCompatible: 'Connect any OpenAI-compatible endpoint.',
    includesModels: ({ models, more }: { models: string; more: boolean }) =>
      `Includes ${models}${more ? ', and more' : ''}.`,
    auth: {
      'amazon-bedrock': {
        note: 'Bedrock uses your AWS credentials (a named profile, IAM role, or AWS_* environment variables) — there is no API key to paste here.',
        docsLabel: 'AWS credential setup',
      },
      'google-vertex': {
        note: 'Vertex AI uses Google Cloud Application Default Credentials (run `gcloud auth application-default login`) — there is no API key to paste here.',
        docsLabel: 'Set up ADC',
      },
    },
    oauth: {
      anthropic: {
        hint: 'Sign in with your Claude Pro or Max subscription — the same Claude account Claude Code and claude.ai use.',
      },
      'github-copilot': {
        hint: 'Sign in with your GitHub account — no API key to paste.',
        docsLabel: 'About GitHub Copilot',
      },
      'openai-codex': {
        hint: 'Sign in with your ChatGPT Plus or Pro subscription.',
      },
    },
  },
  // Applied tag badges (the `#tag` chips on a node).
  tags: {
    deletedTitle: ({ label }: { label: string }) => `Tag "${label}" has been deleted`,
    removeAriaLabel: ({ label }: { label: string }) => `Remove ${label} tag`,
    removeTitle: 'Remove tag',
    openAriaLabel: ({ label }: { label: string }) => `Open ${label} tag`,
    // The tag context menu (right-click a tag badge). `#${label}` keeps the tag
    // name verbatim.
    everythingTagged: ({ label }: { label: string }) => `Everything tagged #${label}`,
    configureTag: 'Configure tag',
  },
  // The search-node query UI: the summary bar (read-only chips) and the inline
  // query builder, plus the chip vocabulary for each query operator.
  search: {
    builder: {
      title: 'Query',
      refreshTitle: 'Refresh',
      refreshLabel: 'Refresh search results',
      closeTitle: 'Close',
      closeLabel: 'Close query',
      queryAriaLabel: 'Search query',
      statusLocked: 'Locked',
      statusUnsaved: 'Unsaved changes',
      statusSaved: 'Saved',
      reset: 'Reset',
      saving: 'Saving',
      save: 'Save',
      saveError: 'Could not save query.',
    },
    summary: {
      rulesAriaLabel: 'Search rules',
      noRules: 'No rules',
      refreshTitle: 'Refresh',
      refreshLabel: 'Refresh search results',
    },
    // The materialized-result counter, shared by the bar and the builder.
    // TODO plural via Intl
    resultCount: ({ count }: { count: number }) => `${count} ${count === 1 ? 'result' : 'results'}`,
    // The chip label for each query rule. Operator-symbol rules (=, !=, <, >) keep
    // their symbols inline and are not listed here; only word-bearing rules are.
    rules: {
      hasTag: 'Has tag',
      fieldFallback: 'Field',
      targetFallback: 'target',
      // Field-value / field-state rules.
      contains: ({ field, value }: { field: string; value: string }) => `${field} contains ${value}`,
      containsBare: ({ field }: { field: string }) => `${field} contains`,
      overlaps: ({ field, value }: { field: string; value: string }) => `${field} overlaps ${value}`,
      overlapsBare: ({ field }: { field: string }) => `${field} overlaps date`,
      isEmpty: ({ field }: { field: string }) => `${field} is empty`,
      isNotEmpty: ({ field }: { field: string }) => `${field} is not empty`,
      hasField: ({ field }: { field: string }) => `Has ${field}`,
      hasFieldBare: 'Has field',
      overdue: ({ field }: { field: string }) => `${field} overdue`,
      overdueBare: 'Overdue',
      isSet: ({ field }: { field: string }) => `${field} is set`,
      isNotSet: ({ field }: { field: string }) => `${field} is not set`,
      isDefined: ({ field }: { field: string }) => `${field} is defined`,
      isNotDefined: ({ field }: { field: string }) => `${field} is not defined`,
      // Target/reference rules.
      linksTo: ({ target }: { target: string }) => `Links to ${target}`,
      childOf: ({ target }: { target: string }) => `Child of ${target}`,
      ownedBy: ({ target }: { target: string }) => `Owned by ${target}`,
      descendantOf: ({ target }: { target: string }) => `Descendant of ${target}`,
      descendantOfWithRefs: ({ target }: { target: string }) => `Descendant of ${target} with refs`,
      // Text / type / date rules.
      text: 'Text',
      regexp: 'Regexp',
      typeEq: ({ value }: { value: string }) => `Type = ${value}`,
      typeBare: 'Type',
      dateEq: ({ value }: { value: string }) => `Date = ${value}`,
      dateBare: 'Date',
      relativeDateBare: 'Relative date',
      siblingNamed: ({ value }: { value: string }) => `Sibling named ${value}`,
      siblingNamedBare: 'Sibling named',
      createdInDays: ({ value }: { value: string }) => `Created in ${value} days`,
      createdRecently: 'Created recently',
      editedInDays: ({ value }: { value: string }) => `Edited in ${value} days`,
      editedRecently: 'Edited recently',
      doneInDays: ({ value }: { value: string }) => `Done in ${value} days`,
      doneRecently: 'Done recently',
      // Logic-group wrapping (AND/OR/NOT keep their DSL keyword; connectors join children).
      logicEmpty: ({ logic }: { logic: string }) => `${logic} empty`,
      logicGroup: ({ logic, body }: { logic: string; body: string }) => `${logic} ${body}`,
      connectorAnd: ' and ',
      connectorOr: ' or ',
    },
  },
  // The agent debug panel — a developer diagnostic surface. Its OWN chrome is
  // localized; the raw protocol it mirrors (message role names, part kinds like
  // `tool_call`/`json`, wire hashes) stays verbatim by design.
  agentDebug: {
    loadingConversation: 'Loading latest agent conversation...',
    noConversation: 'No active agent conversation.',
    title: 'Agent Debug',
    refreshTitle: 'Refresh',
    refreshLabel: 'Refresh agent debug',
    loadingRuntime: 'Loading live runtime data...',
    timelineAriaLabel: 'Provider request timeline',
    noRequests: 'No provider requests captured yet.',
    noRuntimeData: 'No runtime data available.',
    unknown: 'unknown',
    overviewAriaLabel: 'Agent debug overview',
    metricConversation: 'Conversation',
    metricModel: 'Model',
    metricContext: 'Context',
    metricStatus: 'Status',
    // TODO plural via Intl
    queries: ({ count }: { count: number }) => `${count} queries`,
    // TODO plural via Intl
    rounds: ({ count }: { count: number }) => `${count} rounds`,
    requestContext: 'Request Context',
    requestJson: ({ size }: { size: string }) => `${size} request JSON`,
    contextLabel: 'Context',
    contextSummary: ({ total, window, percent }: { total: string; window: string; percent: string }) =>
      `${total} / ${window} tokens · ${percent}`,
    systemPromptDisclosure: ({ size }: { size: string }) => `System Prompt · ${size}`,
    toolsDisclosure: ({ count }: { count: number }) => `Tools · ${count}`,
    noTools: 'No tools in this request.',
    noDescription: 'No description',
    empty: '(empty)',
    statSystem: 'system',
    statTools: 'tools',
    statMessages: 'messages',
    statTotal: 'total',
    queryIndex: ({ index }: { index: number }) => `Q${index}`,
    round: ({ index }: { index: number }) => `Round ${index}`,
    usagePending: 'usage pending',
    // TODO plural via Intl
    messagesSubsection: ({ count }: { count: number }) => `Messages · ${count} request messages`,
    rawPayload: ({ size }: { size: string }) => `Raw Provider Payload · ${size}`,
    copyRawPayload: 'Copy Raw Provider Payload',
    payloadUnavailableNow: 'Payload is no longer available.',
    loadingPayload: 'Loading payload...',
    openToLoad: 'Open this section to load the stored payload.',
    rawPayloadUnavailable: 'Raw payload is unavailable.',
    providerResponse: 'Provider response',
    noResponseParts: 'No response parts captured yet.',
    rawMessageJson: 'Raw message JSON',
    copyTitle: ({ title }: { title: string }) => `Copy ${title}`,
    requestFallbackPreview: ({ index }: { index: number }) => `Provider request #${index}`,
    // Capture-source labels (the panel's own description of where a snapshot came from).
    sourceProviderPayload: 'Provider payload',
    sourceProviderResponse: 'Provider response',
    sourceRuntimeState: 'Runtime state',
    // Status labels.
    statusRunning: 'Running',
    statusCompleted: 'Completed',
    statusAborted: 'Aborted',
    statusInterrupted: 'Interrupted',
    statusError: 'Error',
  },
};

export type Messages = typeof en;
