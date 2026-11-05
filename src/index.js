/**
 * @license
 * Copyright 2021 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as Constants from '../src/constants';

import {
  FlyoutCursor,
  pluginInfo as FlyoutCursorPluginInfo,
} from './cursors/flyout_cursor';
import {Navigation} from './navigation';
import {NavigationController} from './navigation_controller';
import {AccessibleCursor} from "./cursors/accessible_cursor";
import {
  registerCustomBlocks,
  attachCustomBlocks,
  blockTypes,
  withConnectionRulesSuspended,
  Activity,
  EditMode,
  LearnerLevel,
  getPolicy,
  setPolicy,
  onPolicyChange,
  QuestionBlock,
} from "./blocks/index.js";
import {describeBlockLocation} from "./labels_and_comments/location.js";
import {AgentError, AgentErrorCode} from "./agent/services/contracts.js";
import {createFakeAgentServices} from "./agent/services/fake_services.js";
import {createAgentServices} from "./agent/services/agent_services.js";
import {createOfflineAgentClient} from "./agent/model/fake.js";
import {createAgentServerClient} from "./agent/model/server_client.js";
import {createCoordinator, stepLine} from "./interaction/coordinator.js";
import {matchCommand} from "./interaction/commands.js";
import {createActivityCounter, createEventSender} from "./interaction/events.js";
import {NavigationLock} from "./util/navigation_lock.js";
import {bindAssistantKeys} from "./util/assistant_keys.js";
import {createOutputManager, DEFAULT_OUTPUT_SETTINGS} from "./output/output_manager.js";
import {bindTypingEcho} from "./output/typing_echo.js";
import {setOutputManager} from "./output/active.js";
import {EARCONS} from "./output/earcons.js";
import {localVoices, nativeAiVoice, preferPageVoice, systemVoice} from "./output/voices.js";
import {pageVoice} from "./output/page_voice.js";
import {watchOperationCues} from "./output/operation_cues.js";
import {createConversationController, SessionState} from "./voice/conversation_controller.js";
import {blockTypeName} from "./blocks/block_names.js";
import {getStackLabelManager} from "./labels_and_comments/stack_labels.js";
import {compileProgram} from "./runner/compile.js";
import {HEADLESS_LIMITS, LEARNER_LIMITS, toExecution} from "./runner/run_core.js";
import {createWorkerRunner} from "./runner/worker_runner.js";


export {
  Constants,
  FlyoutCursor,
  FlyoutCursorPluginInfo,
  Navigation,
  NavigationController,
  AccessibleCursor,
  registerCustomBlocks,
  attachCustomBlocks,
  blockTypes,
  withConnectionRulesSuspended,
  Activity,
  EditMode,
  LearnerLevel,
  getPolicy,
  setPolicy,
  onPolicyChange,
  QuestionBlock,
  describeBlockLocation,
  AgentError, AgentErrorCode,
  createFakeAgentServices,
  createAgentServices,
  createOfflineAgentClient,
  createAgentServerClient,
  createCoordinator, stepLine, matchCommand, createEventSender, createActivityCounter, NavigationLock, bindAssistantKeys,
  createOutputManager, DEFAULT_OUTPUT_SETTINGS, setOutputManager, EARCONS, bindTypingEcho, localVoices, nativeAiVoice, pageVoice, preferPageVoice, systemVoice,
  watchOperationCues,
  createConversationController, SessionState, blockTypeName,
  getStackLabelManager,
  compileProgram, createWorkerRunner, HEADLESS_LIMITS, LEARNER_LIMITS, toExecution,
};

export {voiceVocabulary} from './voice/vocabulary.js';
export {authorshipSummary, authorshipLine} from './blocks/authorship_summary.js';
export {authorshipOf} from './blocks/authorship.js';
