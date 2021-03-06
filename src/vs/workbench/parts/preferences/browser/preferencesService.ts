/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'vs/css!./media/preferences';
import * as network from 'vs/base/common/network';
import { TPromise } from 'vs/base/common/winjs.base';
import * as nls from 'vs/nls';
import URI from 'vs/base/common/uri';
import { ResourceMap } from 'vs/base/common/map';
import * as labels from 'vs/base/common/labels';
import * as strings from 'vs/base/common/strings';
import { Disposable } from 'vs/base/common/lifecycle';
import { Emitter } from 'vs/base/common/event';
import { EditorInput } from 'vs/workbench/common/editor';
import { IWorkbenchEditorService } from 'vs/workbench/services/editor/common/editorService';
import { IWorkspaceContextService, WorkbenchState } from 'vs/platform/workspace/common/workspace';
import { IWorkspaceConfigurationService } from 'vs/workbench/services/configuration/common/configuration';
import { Position as EditorPosition, IEditor, IEditorOptions } from 'vs/platform/editor/common/editor';
import { ICommonCodeEditor } from 'vs/editor/common/editorCommon';
import { IEditorGroupService } from 'vs/workbench/services/group/common/groupService';
import { IStorageService } from 'vs/platform/storage/common/storage';
import { IFileService, FileOperationError, FileOperationResult } from 'vs/platform/files/common/files';
import { IMessageService, Severity, IChoiceService } from 'vs/platform/message/common/message';
import { IExtensionService } from 'vs/platform/extensions/common/extensions';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { IConfigurationEditingService, ConfigurationTarget } from 'vs/workbench/services/configuration/common/configurationEditing';
import { IPreferencesService, IPreferencesEditorModel, ISetting, getSettingsTargetName, FOLDER_SETTINGS_PATH, DEFAULT_SETTINGS_EDITOR_SETTING } from 'vs/workbench/parts/preferences/common/preferences';
import { SettingsEditorModel, DefaultSettingsEditorModel, DefaultKeybindingsEditorModel, defaultKeybindingsContents, WorkspaceConfigModel } from 'vs/workbench/parts/preferences/common/preferencesModels';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { DefaultPreferencesEditorInput, PreferencesEditorInput } from 'vs/workbench/parts/preferences/browser/preferencesEditor';
import { KeybindingsEditorInput } from 'vs/workbench/parts/preferences/browser/keybindingsEditor';
import { ITextModelService } from 'vs/editor/common/services/resolverService';
import { getCodeEditor } from 'vs/editor/common/services/codeEditorService';
import { EditOperation } from 'vs/editor/common/core/editOperation';
import { Position, IPosition } from 'vs/editor/common/core/position';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { IModelService } from 'vs/editor/common/services/modelService';
import { IJSONEditingService } from 'vs/workbench/services/configuration/common/jsonEditing';
import { ConfigurationScope } from 'vs/platform/configuration/common/configurationRegistry';

const emptyEditableSettingsContent = '{\n}';

export class PreferencesService extends Disposable implements IPreferencesService {

	_serviceBrand: any;

	// TODO:@sandy merge these models into editor inputs by extending resource editor model
	private defaultPreferencesEditorModels: ResourceMap<TPromise<IPreferencesEditorModel<any>>>;
	private lastOpenedSettingsInput: PreferencesEditorInput = null;

	private _onDispose: Emitter<void> = new Emitter<void>();

	constructor(
		@IWorkbenchEditorService private editorService: IWorkbenchEditorService,
		@IEditorGroupService private editorGroupService: IEditorGroupService,
		@IFileService private fileService: IFileService,
		@IWorkspaceConfigurationService private configurationService: IWorkspaceConfigurationService,
		@IMessageService private messageService: IMessageService,
		@IChoiceService private choiceService: IChoiceService,
		@IWorkspaceContextService private contextService: IWorkspaceContextService,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IStorageService private storageService: IStorageService,
		@IEnvironmentService private environmentService: IEnvironmentService,
		@ITelemetryService private telemetryService: ITelemetryService,
		@ITextModelService private textModelResolverService: ITextModelService,
		@IConfigurationEditingService private configurationEditingService: IConfigurationEditingService,
		@IExtensionService private extensionService: IExtensionService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IModelService private modelService: IModelService,
		@IJSONEditingService private jsonEditingService: IJSONEditingService
	) {
		super();
		this.defaultPreferencesEditorModels = new ResourceMap<TPromise<IPreferencesEditorModel<any>>>();
		this.editorGroupService.onEditorsChanged(() => {
			const activeEditorInput = this.editorService.getActiveEditorInput();
			if (activeEditorInput instanceof PreferencesEditorInput) {
				this.lastOpenedSettingsInput = activeEditorInput;
			}
		});

		// The default keybindings.json updates based on keyboard layouts, so here we make sure
		// if a model has been given out we update it accordingly.
		keybindingService.onDidUpdateKeybindings(() => {
			const model = modelService.getModel(this.defaultKeybindingsResource);
			if (!model) {
				// model has not been given out => nothing to do
				return;
			}
			modelService.updateModel(model, defaultKeybindingsContents(keybindingService));
		});
	}

	readonly defaultSettingsResource = URI.from({ scheme: network.Schemas.vscode, authority: 'defaultsettings', path: '/settings.json' });
	readonly defaultResourceSettingsResource = URI.from({ scheme: network.Schemas.vscode, authority: 'defaultsettings', path: '/resourceSettings.json' });
	readonly defaultKeybindingsResource = URI.from({ scheme: network.Schemas.vscode, authority: 'defaultsettings', path: '/keybindings.json' });
	private readonly workspaceConfigSettingsResource = URI.from({ scheme: network.Schemas.vscode, authority: 'settings', path: '/workspaceSettings.json' });

	get userSettingsResource(): URI {
		return this.getEditableSettingsURI(ConfigurationTarget.USER);
	}

	get workspaceSettingsResource(): URI {
		return this.getEditableSettingsURI(ConfigurationTarget.WORKSPACE);
	}

	getFolderSettingsResource(resource: URI): URI {
		return this.getEditableSettingsURI(ConfigurationTarget.FOLDER, resource);
	}

	resolveContent(uri: URI): TPromise<string> {
		const workspaceSettingsUri = this.getEditableSettingsURI(ConfigurationTarget.WORKSPACE);
		if (workspaceSettingsUri && workspaceSettingsUri.toString() === uri.toString()) {
			return this.resolveSettingsContentFromWorkspaceConfiguration();
		}
		return this.createPreferencesEditorModel(uri)
			.then(preferencesEditorModel => preferencesEditorModel ? preferencesEditorModel.content : null);
	}

	createPreferencesEditorModel(uri: URI): TPromise<IPreferencesEditorModel<any>> {
		let promise = this.defaultPreferencesEditorModels.get(uri);
		if (promise) {
			return promise;
		}

		if (this.defaultSettingsResource.toString() === uri.toString()) {
			promise = TPromise.join<any>([this.extensionService.onReady(), this.fetchMostCommonlyUsedSettings()])
				.then(result => {
					const mostCommonSettings = result[1];
					const model = this.instantiationService.createInstance(DefaultSettingsEditorModel, uri, mostCommonSettings, ConfigurationScope.WINDOW);
					return model;
				});
			this.defaultPreferencesEditorModels.set(uri, promise);
			return promise;
		}

		if (this.defaultResourceSettingsResource.toString() === uri.toString()) {
			promise = TPromise.join<any>([this.extensionService.onReady(), this.fetchMostCommonlyUsedSettings()])
				.then(result => {
					const mostCommonSettings = result[1];
					const model = this.instantiationService.createInstance(DefaultSettingsEditorModel, uri, mostCommonSettings, ConfigurationScope.RESOURCE);
					return model;
				});
			this.defaultPreferencesEditorModels.set(uri, promise);
			return promise;
		}

		if (this.defaultKeybindingsResource.toString() === uri.toString()) {
			const model = this.instantiationService.createInstance(DefaultKeybindingsEditorModel, uri);
			promise = TPromise.wrap(model);
			this.defaultPreferencesEditorModels.set(uri, promise);
			return promise;
		}

		if (this.workspaceConfigSettingsResource.toString() === uri.toString()) {
			promise = this.createEditableSettingsEditorModel(ConfigurationTarget.WORKSPACE, uri);
			this.defaultPreferencesEditorModels.set(uri, promise);
			return promise;
		}

		if (this.getEditableSettingsURI(ConfigurationTarget.USER).toString() === uri.toString()) {
			return this.createEditableSettingsEditorModel(ConfigurationTarget.USER, uri);
		}

		const workspaceSettingsUri = this.getEditableSettingsURI(ConfigurationTarget.WORKSPACE);
		if (workspaceSettingsUri && workspaceSettingsUri.toString() === uri.toString()) {
			return this.createEditableSettingsEditorModel(ConfigurationTarget.WORKSPACE, workspaceSettingsUri);
		}

		if (this.contextService.getWorkbenchState() === WorkbenchState.WORKSPACE) {
			return this.createEditableSettingsEditorModel(ConfigurationTarget.FOLDER, uri);
		}

		return TPromise.wrap<IPreferencesEditorModel<any>>(null);
	}

	openGlobalSettings(options?: IEditorOptions, position?: EditorPosition): TPromise<IEditor> {
		return this.doOpenSettings(ConfigurationTarget.USER, this.userSettingsResource, options, position);
	}

	openWorkspaceSettings(options?: IEditorOptions, position?: EditorPosition): TPromise<IEditor> {
		if (this.contextService.getWorkbenchState() === WorkbenchState.EMPTY) {
			this.messageService.show(Severity.Info, nls.localize('openFolderFirst', "Open a folder first to create workspace settings"));
			return TPromise.as(null);
		}
		return this.doOpenSettings(ConfigurationTarget.WORKSPACE, this.workspaceSettingsResource, options, position);
	}

	openFolderSettings(folder: URI, options?: IEditorOptions, position?: EditorPosition): TPromise<IEditor> {
		return this.doOpenSettings(ConfigurationTarget.FOLDER, this.getEditableSettingsURI(ConfigurationTarget.FOLDER, folder), options, position);
	}

	switchSettings(target: ConfigurationTarget, resource: URI): TPromise<void> {
		const activeEditor = this.editorService.getActiveEditor();
		const activeEditorInput = activeEditor.input;
		if (activeEditorInput instanceof PreferencesEditorInput) {
			return this.getOrCreateEditableSettingsEditorInput(target, this.getEditableSettingsURI(target, resource))
				.then(toInput => {
					const replaceWith = new PreferencesEditorInput(this.getPreferencesEditorInputName(target, resource), toInput.getDescription(), this.instantiationService.createInstance(DefaultPreferencesEditorInput, this.getDefaultSettingsResource(target)), toInput);
					return this.editorService.replaceEditors([{
						toReplace: this.lastOpenedSettingsInput,
						replaceWith
					}], activeEditor.position).then(() => {
						this.lastOpenedSettingsInput = replaceWith;
					});
				});
		} else {
			this.doOpenSettings(target, resource);
			return undefined;
		}
	}

	openGlobalKeybindingSettings(textual: boolean): TPromise<void> {
		/* __GDPR__
			"openKeybindings" : {
				"textual" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
			}
		*/
		this.telemetryService.publicLog('openKeybindings', { textual });
		if (textual) {
			const emptyContents = '// ' + nls.localize('emptyKeybindingsHeader', "Place your key bindings in this file to overwrite the defaults") + '\n[\n]';
			const editableKeybindings = URI.file(this.environmentService.appKeybindingsPath);

			// Create as needed and open in editor
			return this.createIfNotExists(editableKeybindings, emptyContents).then(() => {
				return this.editorService.openEditors([
					{ input: { resource: this.defaultKeybindingsResource, options: { pinned: true }, label: nls.localize('defaultKeybindings', "Default Keybindings"), description: '' }, position: EditorPosition.ONE },
					{ input: { resource: editableKeybindings, options: { pinned: true } }, position: EditorPosition.TWO },
				]).then(() => {
					this.editorGroupService.focusGroup(EditorPosition.TWO);
				});
			});

		}
		return this.editorService.openEditor(this.instantiationService.createInstance(KeybindingsEditorInput), { pinned: true }).then(() => null);
	}

	configureSettingsForLanguage(language: string): void {
		this.openGlobalSettings()
			.then(editor => {
				const codeEditor = getCodeEditor(editor);
				this.getPosition(language, codeEditor)
					.then(position => {
						codeEditor.setPosition(position);
						codeEditor.focus();
					});
			});
	}

	private doOpenSettings(configurationTarget: ConfigurationTarget, resource: URI, options?: IEditorOptions, position?: EditorPosition): TPromise<IEditor> {
		const openDefaultSettings = !!this.configurationService.getValue(DEFAULT_SETTINGS_EDITOR_SETTING);
		return this.getOrCreateEditableSettingsEditorInput(configurationTarget, resource)
			.then(editableSettingsEditorInput => {
				if (!options) {
					options = { pinned: true };
				} else {
					options.pinned = true;
				}

				if (openDefaultSettings) {
					const defaultPreferencesEditorInput = this.instantiationService.createInstance(DefaultPreferencesEditorInput, this.getDefaultSettingsResource(configurationTarget));
					const preferencesEditorInput = new PreferencesEditorInput(this.getPreferencesEditorInputName(configurationTarget, resource), editableSettingsEditorInput.getDescription(), defaultPreferencesEditorInput, <EditorInput>editableSettingsEditorInput);
					this.lastOpenedSettingsInput = preferencesEditorInput;
					return this.editorService.openEditor(preferencesEditorInput, options, position);
				}
				return this.editorService.openEditor(editableSettingsEditorInput, options, position);
			});
	}

	private getDefaultSettingsResource(configurationTarget: ConfigurationTarget): URI {
		if (configurationTarget === ConfigurationTarget.FOLDER) {
			return this.defaultResourceSettingsResource;
		}
		return this.defaultSettingsResource;
	}

	private getPreferencesEditorInputName(target: ConfigurationTarget, resource: URI): string {
		const name = getSettingsTargetName(target, resource, this.contextService);
		return target === ConfigurationTarget.FOLDER ? nls.localize('folderSettingsName', "{0} (Folder Settings)", name) : name;
	}

	private getOrCreateEditableSettingsEditorInput(target: ConfigurationTarget, resource: URI): TPromise<EditorInput> {
		return this.createSettingsIfNotExists(target, resource)
			.then(() => <EditorInput>this.editorService.createInput({ resource }));
	}

	private createEditableSettingsEditorModel(configurationTarget: ConfigurationTarget, resource: URI): TPromise<SettingsEditorModel> {
		const settingsUri = this.getEditableSettingsURI(configurationTarget, resource);
		if (settingsUri) {
			if (settingsUri.toString() === this.workspaceConfigSettingsResource.toString()) {
				return TPromise.join([this.textModelResolverService.createModelReference(settingsUri), this.textModelResolverService.createModelReference(this.contextService.getWorkspace().configuration)])
					.then(([reference, workspaceConfigReference]) => this.instantiationService.createInstance(WorkspaceConfigModel, reference, workspaceConfigReference, configurationTarget, this._onDispose.event));
			}
			return this.textModelResolverService.createModelReference(settingsUri)
				.then(reference => this.instantiationService.createInstance(SettingsEditorModel, reference, configurationTarget));
		}
		return TPromise.wrap<SettingsEditorModel>(null);
	}

	private resolveSettingsContentFromWorkspaceConfiguration(): TPromise<string> {
		if (this.contextService.getWorkbenchState() === WorkbenchState.WORKSPACE) {
			return this.textModelResolverService.createModelReference(this.contextService.getWorkspace().configuration)
				.then(reference => {
					const model = reference.object.textEditorModel;
					const settingsContent = WorkspaceConfigModel.getSettingsContentFromConfigContent(model.getValue());
					reference.dispose();
					return TPromise.as(settingsContent ? settingsContent : emptyEditableSettingsContent);
				});
		}
		return TPromise.as(null);
	}

	private getEditableSettingsURI(configurationTarget: ConfigurationTarget, resource?: URI): URI {
		switch (configurationTarget) {
			case ConfigurationTarget.USER:
				return URI.file(this.environmentService.appSettingsPath);
			case ConfigurationTarget.WORKSPACE:
				if (this.contextService.getWorkbenchState() === WorkbenchState.EMPTY) {
					return null;
				}
				const workspace = this.contextService.getWorkspace();
				return workspace.configuration || workspace.folders[0].toResource(FOLDER_SETTINGS_PATH);
			case ConfigurationTarget.FOLDER:
				const folder = this.contextService.getWorkspaceFolder(resource);
				return folder ? folder.toResource(FOLDER_SETTINGS_PATH) : null;
		}
		return null;
	}

	private createSettingsIfNotExists(target: ConfigurationTarget, resource: URI): TPromise<void> {
		if (this.contextService.getWorkbenchState() === WorkbenchState.WORKSPACE && target === ConfigurationTarget.WORKSPACE) {
			if (!this.configurationService.keys().workspace.length) {
				return this.jsonEditingService.write(resource, { key: 'settings', value: {} }, true).then(null, () => { });
			}
		}
		return this.createIfNotExists(resource, emptyEditableSettingsContent).then(() => { });
	}

	private createIfNotExists(resource: URI, contents: string): TPromise<any> {
		return this.fileService.resolveContent(resource, { acceptTextOnly: true }).then(null, error => {
			if ((<FileOperationError>error).fileOperationResult === FileOperationResult.FILE_NOT_FOUND) {
				return this.fileService.updateContent(resource, contents).then(null, error => {
					return TPromise.wrapError(new Error(nls.localize('fail.createSettings', "Unable to create '{0}' ({1}).", labels.getPathLabel(resource, this.contextService, this.environmentService), error)));
				});
			}

			return TPromise.wrapError(error);
		});
	}

	private fetchMostCommonlyUsedSettings(): TPromise<string[]> {
		return TPromise.wrap([
			'files.autoSave',
			'editor.fontSize',
			'editor.fontFamily',
			'editor.tabSize',
			'editor.renderWhitespace',
			'editor.cursorStyle',
			'editor.multiCursorModifier',
			'editor.insertSpaces',
			'editor.wordWrap',
			'files.exclude',
			'files.associations'
		]);
	}

	private getPosition(language: string, codeEditor: ICommonCodeEditor): TPromise<IPosition> {
		return this.createPreferencesEditorModel(this.userSettingsResource)
			.then((settingsModel: IPreferencesEditorModel<ISetting>) => {
				const languageKey = `[${language}]`;
				let setting = settingsModel.getPreference(languageKey);
				const model = codeEditor.getModel();
				const configuration = this.configurationService.getConfiguration<{ tabSize: number; insertSpaces: boolean }>('editor');
				const { eol } = this.configurationService.getConfiguration<{ eol: string }>('files');
				if (setting) {
					if (setting.overrides.length) {
						const lastSetting = setting.overrides[setting.overrides.length - 1];
						let content;
						if (lastSetting.valueRange.endLineNumber === setting.range.endLineNumber) {
							content = ',' + eol + this.spaces(2, configuration) + eol + this.spaces(1, configuration);
						} else {
							content = ',' + eol + this.spaces(2, configuration);
						}
						const editOperation = EditOperation.insert(new Position(lastSetting.valueRange.endLineNumber, lastSetting.valueRange.endColumn), content);
						model.pushEditOperations([], [editOperation], () => []);
						return { lineNumber: lastSetting.valueRange.endLineNumber + 1, column: model.getLineMaxColumn(lastSetting.valueRange.endLineNumber + 1) };
					}
					return { lineNumber: setting.valueRange.startLineNumber, column: setting.valueRange.startColumn + 1 };
				}
				return this.configurationEditingService.writeConfiguration(ConfigurationTarget.USER, { key: languageKey, value: {} }, { donotSave: true })
					.then(() => {
						setting = settingsModel.getPreference(languageKey);
						let content = eol + this.spaces(2, configuration) + eol + this.spaces(1, configuration);
						let editOperation = EditOperation.insert(new Position(setting.valueRange.endLineNumber, setting.valueRange.endColumn - 1), content);
						model.pushEditOperations([], [editOperation], () => []);
						let lineNumber = setting.valueRange.endLineNumber + 1;
						settingsModel.dispose();
						return { lineNumber, column: model.getLineMaxColumn(lineNumber) };
					});
			});
	}

	private spaces(count: number, { tabSize, insertSpaces }: { tabSize: number; insertSpaces: boolean }): string {
		return insertSpaces ? strings.repeat(' ', tabSize * count) : strings.repeat('\t', count);
	}

	public dispose(): void {
		this._onDispose.fire();
		this.defaultPreferencesEditorModels.clear();
		super.dispose();
	}
}
