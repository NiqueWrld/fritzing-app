# Education-Focused Fritzing Plan

## Purpose

Create an optional education-focused experience inside Fritzing that helps
learners build circuits step by step while letting educators distribute,
review, and assess activities. The standard Fritzing workflow must remain
unchanged when education features are disabled.

## Users

- Learners build and test guided circuit activities.
- Educators create activities, provide starter files, and review submissions.
- Lab administrators install shared content and configure local defaults.

## Product Principles

- Keep Fritzing usable offline and without an account.
- Build on Breadboard, Schematic, PCB, and existing parts rather than creating
  a second editor.
- Preserve user ownership of sketches and avoid collecting learner data by
  default.
- Make the education features optional and reversible.
- Keep activity files portable so they can be shared as ordinary project files.

## First Release

### Built-In Beginner Tutorial

Ship one complete, offline tutorial before building the activity browser or
educator authoring features. The tutorial, "Build an LED Circuit", introduces
the interface and teaches a safe LED-and-resistor circuit.

- Welcome the learner and explain the Breadboard, Schematic, and PCB views.
- Guide the learner to place a breadboard, LED, resistor, battery, and wires.
- Explain LED polarity and resistor selection at the relevant step.
- Highlight the next part or connection without automatically completing it.
- Check that the required parts and connections exist before advancing.
- Finish with a short recap and let the learner save the completed sketch.

### Education Workspace

- Add an Education mode entry point to the application UI.
- Provide an activity browser with title, subject, difficulty, duration, and
  completion state.
- Show a focused task panel beside the sketch without hiding the normal views.
- Include previous/next step controls and a clear exit back to standard mode.

### Guided Activities

- Define an activity manifest format stored with a Fritzing sketch package.
- Support ordered steps with instructions, target view, highlighted parts, and
  optional checkpoints.
- Use the LED tutorial as the first activity and add further activities only
  after it has been tested with learners.
- Save learner progress locally and allow restarting an activity.

### Educator Tools

- Add an activity authoring dialog for creating steps from an existing sketch.
- Let educators attach a rubric, reference image, notes, and solution sketch.
- Export an activity as a shareable package.
- Import activities from a local file or folder.

### Assessment

- Validate basic circuit requirements through explicit checks, such as required
  parts, values, and connector relationships.
- Show constructive feedback for failed checks without exposing the solution.
- Export a learner submission package containing the sketch and completion
  metadata.
- Keep automated checks deterministic and usable without network access.

## Technical Approach

1. Add an `EducationController` owned by the main window to manage mode,
   activity state, and persistence.
2. Represent activities with a versioned JSON manifest and package assets in a
   `.fzz`-compatible archive or a documented companion archive.
3. Reuse `SketchWidget`, `ReferenceModel`, connector data, and undo commands
   for highlighting and validation.
4. Add a dockable `EducationPanel` for activity navigation and feedback.
5. Store local progress with `QSettings`, keyed by stable activity and version
   identifiers.
6. Keep import/export code separate from UI so future LMS integrations can use
   the same activity model.

## Phases

### Phase 0: Discovery

- Review current sketch serialization, parts-bin handling, and dock patterns.
- Interview educators to select age range, curriculum, and classroom workflow.
- Decide the activity package format and compatibility policy.

### Phase 1: LED Tutorial

- Add a Tutorial entry point and a compact dockable tutorial panel.
- Create the "Build an LED Circuit" starter sketch and ordered tutorial steps.
- Implement part highlighting, step navigation, and connection checkpoints.
- Save and restore progress for this tutorial locally.
- Test the complete tutorial with a new Fritzing user.

### Phase 2: Generalized Activities

- Extract the LED tutorial data into a versioned activity manifest.
- Implement local activity discovery and an activity browser.
- Add push-button and Arduino starter activities.
- Test keyboard-only and small-screen usability.

### Phase 3: Educator Experience

- Implement authoring, import, export, and submission packages.
- Add rubric metadata and read-only solution handling.
- Document activity creation with an example project.

### Phase 4: Validation and Release

- Add tests for manifest migrations, activity loading, validation rules, and
  import/export round trips.
- Run usability sessions with learners and educators.
- Release the feature as opt-in and collect only voluntary feedback.

## Non-Goals for the First Release

- Mandatory accounts, cloud sync, or online-only content.
- Real-time classroom monitoring.
- Automated grading of arbitrary circuit designs.
- Replacing standard Fritzing tutorials or parts editing.

## Acceptance Criteria

- A new learner can complete the offline LED tutorial, save progress, and save
  the finished sketch without an account or internet connection.
- The tutorial does not advance until the required parts and connections are
  present, and it explains how to correct failed checkpoints.
- An educator can create a simple activity from a sketch and import it on a
  second computer.
- A malformed or incompatible activity displays a useful error and never
  damages the learner's sketch.
- Disabling Education mode leaves normal Fritzing behavior unchanged.