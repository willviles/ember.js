import { guidFor, OWNER } from 'ember-utils';
import { Cache, assert, warn, runInDebug, isFeatureEnabled } from 'ember-metal';
import {
  lookupPartial,
  hasPartial,
  lookupComponent,
  STYLE_WARNING
} from 'ember-views';
import {
  Environment as GlimmerEnvironment,
  AttributeManager,
  isSafeString,
  compileLayout,
  getDynamicVar
} from '@glimmer/runtime';
import {
  CurlyComponentDefinition
} from './syntax/curly-component';
import {
  populateMacros
} from './syntax';
import createIterable from './utils/iterable';
import {
  ConditionalReference,
  SimpleHelperReference,
  ClassBasedHelperReference
} from './utils/references';
import DebugStack from './utils/debug-stack';

import {
  inlineIf,
  inlineUnless
} from './helpers/if-unless';
import { default as action } from './helpers/action';
import { default as componentHelper } from './helpers/component';
import { default as concat } from './helpers/concat';
import { default as get } from './helpers/get';
import { default as hash } from './helpers/hash';
import { default as loc } from './helpers/loc';
import { default as log } from './helpers/log';
import { default as mut } from './helpers/mut';
import { default as readonly } from './helpers/readonly';
import { default as unbound } from './helpers/unbound';
import { default as classHelper } from './helpers/-class';
import { default as inputTypeHelper } from './helpers/-input-type';
import { default as queryParams } from './helpers/query-param';
import { default as eachIn } from './helpers/each-in';
import { default as normalizeClassHelper } from './helpers/-normalize-class';
import { default as htmlSafeHelper } from './helpers/-html-safe';

import installPlatformSpecificProtocolForURL from './protocol-for-url';
import { FACTORY_FOR } from 'container';

import { default as ActionModifierManager } from './modifiers/action';

export default class Environment extends GlimmerEnvironment {
  static create(options) {
    return new Environment(options);
  }

  constructor({ [OWNER]: owner }) {
    super(...arguments);
    this.owner = owner;
    this.isInteractive = owner.lookup('-environment:main').isInteractive;

    // can be removed once https://github.com/tildeio/glimmer/pull/305 lands
    this.destroyedComponents = undefined;

    installPlatformSpecificProtocolForURL(this);

    this._definitionCache = new Cache(2000, ({ name, source, owner }) => {
      let { component: componentFactory, layout } = lookupComponent(owner, name, { source });

      if (componentFactory || layout) {
        return new CurlyComponentDefinition(name, componentFactory, layout);
      }
    }, ({ name, source, owner }) => {
      let expandedName = source && owner._resolveLocalLookupName(name, source) || name;
      let ownerGuid = guidFor(owner);

      return ownerGuid + '|' + expandedName;
    });

    this._templateCache = new Cache(1000, ({ Template, owner }) => {
      if (Template.create) {
        // we received a factory
        return Template.create({ env: this, [OWNER]: owner });
      } else {
        // we were provided an instance already
        return Template;
      }
    }, ({ Template, owner }) => guidFor(owner) + '|' + Template.id);

    this._compilerCache = new Cache(10, Compiler => {
      return new Cache(2000, (template) => {
        let compilable = new Compiler(template);
        return compileLayout(compilable, this);
      }, (template)=> {
        let owner = template.meta.owner;
        return guidFor(owner) + '|' + template.id;
      });
    }, Compiler => Compiler.id);

    this.builtInModifiers = {
      action: new ActionModifierManager()
    };

    this.builtInHelpers = {
      if: inlineIf,
      action,
      component: componentHelper,
      concat,
      get,
      hash,
      loc,
      log,
      mut,
      'query-params': queryParams,
      readonly,
      unbound,
      unless: inlineUnless,
      '-class': classHelper,
      '-each-in': eachIn,
      '-input-type': inputTypeHelper,
      '-normalize-class': normalizeClassHelper,
      '-html-safe': htmlSafeHelper,
      '-get-dynamic-var': getDynamicVar
    };

    runInDebug(() => this.debugStack = new DebugStack());
  }

  macros() {
    let macros = super.macros();
    populateMacros(macros.blocks, macros.inlines);
    return macros;
  }

  hasComponentDefinition() {
    return false;
  }

  getComponentDefinition(path, symbolTable) {
    let name = path[0];
    let blockMeta = symbolTable.getMeta();
    let owner = blockMeta.owner;
    let source = blockMeta.moduleName && `template:${blockMeta.moduleName}`;

    return this._definitionCache.get({ name, source, owner });
  }

  // normally templates should be exported at the proper module name
  // and cached in the container, but this cache supports templates
  // that have been set directly on the component's layout property
  getTemplate(Template, owner) {
    return this._templateCache.get({ Template, owner });
  }

  // a Compiler can wrap the template so it needs its own cache
  getCompiledBlock(Compiler, template) {
    let compilerCache = this._compilerCache.get(Compiler);
    return compilerCache.get(template);
  }

  hasPartial(name, symbolTable) {
    let { owner } = symbolTable.getMeta();
    return hasPartial(name, owner);
  }

  lookupPartial(name, symbolTable) {
    let { owner } = symbolTable.getMeta();
    let partial = {
      template: lookupPartial(name, owner)
    };

    if (partial.template) {
      return partial;
    } else {
      throw new Error(`${name} is not a partial`);
    }
  }

  hasHelper(nameParts, symbolTable) {
    assert('The first argument passed into `hasHelper` should be an array', Array.isArray(nameParts));

    // helpers are not allowed to include a dot in their invocation
    if (nameParts.length > 1) {
      return false;
    }

    let name = nameParts[0];

    if (this.builtInHelpers[name]) {
      return true;
    }

    let blockMeta = symbolTable.getMeta();
    let owner = blockMeta.owner;
    let options = { source: `template:${blockMeta.moduleName}` };

    return owner.hasRegistration(`helper:${name}`, options) ||
      owner.hasRegistration(`helper:${name}`);
  }

  lookupHelper(nameParts, symbolTable) {
    assert('The first argument passed into `lookupHelper` should be an array', Array.isArray(nameParts));

    let name = nameParts[0];
    let helper = this.builtInHelpers[name];

    if (helper) {
      return helper;
    }

    let blockMeta = symbolTable.getMeta();
    let owner = blockMeta.owner;
    let options = blockMeta.moduleName && { source: `template:${blockMeta.moduleName}` } || {};

    if (isFeatureEnabled('ember-factory-for')) {
      let helperFactory = owner[FACTORY_FOR](`helper:${name}`, options) || owner[FACTORY_FOR](`helper:${name}`);

      // TODO: try to unify this into a consistent protocol to avoid wasteful closure allocations
      if (helperFactory.class.isHelperInstance) {
        return (vm, args) => SimpleHelperReference.create(helperFactory.class.compute, args);
      } else if (helperFactory.class.isHelperFactory) {
        if (!isFeatureEnabled('ember-no-double-extend')) {
          helperFactory = helperFactory.create();
        }
        return (vm, args) => ClassBasedHelperReference.create(helperFactory, vm, args);
      } else {
        throw new Error(`${nameParts} is not a helper`);
      }
    } else {
      let helperFactory = owner.lookup(`helper:${name}`, options) || owner.lookup(`helper:${name}`);

      // TODO: try to unify this into a consistent protocol to avoid wasteful closure allocations
      if (helperFactory.isHelperInstance) {
        return (vm, args) => SimpleHelperReference.create(helperFactory.compute, args);
      } else if (helperFactory.isHelperFactory) {
        return (vm, args) => ClassBasedHelperReference.create(helperFactory, vm, args);
      } else {
        throw new Error(`${nameParts} is not a helper`);
      }
    }
  }

  hasModifier(nameParts) {
    assert('The first argument passed into `hasModifier` should be an array', Array.isArray(nameParts));

    // modifiers are not allowed to include a dot in their invocation
    if (nameParts.length > 1) {
      return false;
    }

    return !!this.builtInModifiers[nameParts[0]];
  }

  lookupModifier(nameParts) {
    assert('The first argument passed into `lookupModifier` should be an array', Array.isArray(nameParts));

    let modifier = this.builtInModifiers[nameParts[0]];

    if (modifier) {
      return modifier;
    } else {
      throw new Error(`${nameParts} is not a modifier`);
    }
  }

  toConditionalReference(reference) {
    return ConditionalReference.create(reference);
  }

  iterableFor(ref, args) {
    let keyPath = args.named.get('key').value();
    return createIterable(ref, keyPath);
  }

  scheduleInstallModifier() {
    if (this.isInteractive) {
      super.scheduleInstallModifier(...arguments);
    }
  }

  scheduleUpdateModifier() {
    if (this.isInteractive) {
      super.scheduleUpdateModifier(...arguments);
    }
  }

  didDestroy(destroyable) {
    destroyable.destroy();
  }

  begin() {
    this.inTransaction = true;

    super.begin();

    this.destroyedComponents = [];
  }

  commit() {
    // components queued for destruction must be destroyed before firing
    // `didCreate` to prevent errors when removing and adding a component
    // with the same name (would throw an error when added to view registry)
    for (let i = 0; i < this.destroyedComponents.length; i++) {
      this.destroyedComponents[i].destroy();
    }

    super.commit();

    this.inTransaction = false;
  }
}

runInDebug(() => {
  class StyleAttributeManager extends AttributeManager {
    setAttribute(dom, element, value) {
      warn(STYLE_WARNING, (() => {
        if (value === null || value === undefined || isSafeString(value)) {
          return true;
        }
        return false;
      })(), { id: 'ember-htmlbars.style-xss-warning' });
      super.setAttribute(...arguments);
    }

    updateAttribute(dom, element, value) {
      warn(STYLE_WARNING, (() => {
        if (value === null || value === undefined || isSafeString(value)) {
          return true;
        }
        return false;
      })(), { id: 'ember-htmlbars.style-xss-warning' });
      super.updateAttribute(...arguments);
    }
  }

  let STYLE_ATTRIBUTE_MANANGER = new StyleAttributeManager('style');

  Environment.prototype.attributeFor = function(element, attribute, isTrusting, namespace) {
    if (attribute === 'style' && !isTrusting) {
      return STYLE_ATTRIBUTE_MANANGER;
    }

    return GlimmerEnvironment.prototype.attributeFor.call(this, element, attribute, isTrusting);
  };
});
