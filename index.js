const util             = require('util');
const getPathValue     = require('@walcu-engineering/getpathvalue');
const previousValue    = require('@walcu-engineering/previousvalue');
const pathHasChanged   = require('@walcu-engineering/pathhaschanged');
const { EventEmitter } = require('events');

class CustomEmmiter extends EventEmitter {};
const mutable_array_methods = ['copyWithin', 'fill', 'pop', 'push', 'reverse', 'shift', 'splice']; //This are all the array methods that mutates the array itself

/**
 * This function will take the this_arg and will take the unchecked changes.
 * For the given path of the unchecked change, will take that path current value
 * and it will be compared with the current value for the change's path.
 * From that comparission we will determine if that change should be kept, or if it
 * must be removed.
 *
 * Since sometimes mongoose calls the markModified function before updating a given value
 * we set those kind of changes as 'unchecked', and in the next change, or whenever a
 * function dependant on the changes get called, we checked those unchecked changes to verify
 * if they are legitimate
 */
function checkUncheckedChanges(){
  const changes = this.$locals?.changes ?? [];
  let unchecked_change_index = changes?.findIndex(change => change.unchecked);
  while (unchecked_change_index >= 0) {
    const unchecked_change = changes[unchecked_change_index];
    const current_value = getPathValue(this, unchecked_change.path);
    const old_value = unchecked_change.old_value;
    if (!util.isDeepStrictEqual(current_value, old_value)) {
      delete changes[unchecked_change_index].unchecked;
    } else {//This is not an actual change because the new value is the same than the old one
      const unchecked_change_dotted_path = unchecked_change.path.split('/').slice(1).join('.');
      this.$locals.visited = this.$locals.visited.filter(visited_dotted_path => unchecked_change_dotted_path !== visited_dotted_path);//we have to mark this path as unvisited because maybe it can change in the future
      this.$locals.changes = changes.filter((_, i) => i !== unchecked_change_index); //we are removing this change from the changes array because it is not an actual change.
    }
    unchecked_change_index = this.$locals.changes.findIndex(change => change.unchecked);
  }
}

const transformToJSObject = obj => obj?.toObject?.() ?? obj;

const getOldValue = (this_arg, arglist) => {
  const old_value = transformToJSObject(this_arg.get(arglist[0]));
  //We have to check if we have come here from a method that mutates the array (at this point the array has not been modified yet)
  //because in that case we have to create a copy of the array. Otherwise we will have the same array and cannot check for the differences
  //That's why whe have to throw the Error, in order to have access to the call stack to see if we have reached this code from a
  //mutable array method.
  if(Array.isArray(old_value)){
    let call_stack = [];
    try{
      throw new Error();
    }catch(error){
      call_stack = error.stack.split('\n').slice(2).map(line => line.trim().slice(3).split(' ')[0]);//The 2 first error lines are the word error and the file path where the error happened. In the map we remove the "at " substring, and we keep only the first word that is the function call stack
    }
    //When a mutable array method is called inside mongoose, before the actual array mutation happens,
    //the _markModify function is called, and it is captured by this proxy, so the index before the
    //mutable array method stack call index, must be _markModified, or "Proxy._markModified" because
    //mongoose makes Proxies of the Arrays.
    const mutable_array_call_stack_index = call_stack.findIndex(stack_call_line => mutable_array_methods.some(mutable_method => stack_call_line.includes(mutable_method)));
    if(mutable_array_call_stack_index > 1 && call_stack[mutable_array_call_stack_index - 1].includes('_markModified')){
      //return old_value.map(v => v?.constructor ? new v.constructor(v) : v);
      return old_value.map(x => x);
    }else{
      return old_value;
    }
  }else{
    return old_value;
  }
}

const markVisited = (document, change) => {
  if (document.$locals.visited) {
    if (!change[1]?.$locals?.visited) document.$locals.visited.push(change[0]);
  } else {
    if (!change[1]?.$locals?.visited) document.$locals.visited = [change[0]];
  }
}

/*
 * DARK MAGIC HERE. BE CAREFUL OR YOU COULD HARM YOURSELF.
 * In Mongoose there are 2 ways of updating a document:
 * A) Using model.set
 *   Example: mymodel.set('very.nested.path.here', value);
 * B) Using the dot notation
 *   Example: mymodel.very.nested.path.here = value;
 *
 * When you use 'set', this function will be call the first
 * time with with an arglist of 2 elements, the first one is
 * the path in dotted notation, and the second one is the new
 * value that is going to be given to the path.
 *
 * However this is true only for paths that are simple types,
 * and do not contain anywhere in the path any array, because
 * in such case the path is called several times.
 *
 * Thats why we have to check if we have already visited the
 * path, if we have already visited that path it is not
 * necessary to check it again because we only need the oldest
 * change.
 *
 * When you set a inner array value with the "=" assignation
 * then the arglist does not give us the new value for the
 * given path, and that's why we have to introduce an
 * unchecked change, because we cannot guarantee that the change
 * is a valid one, so we emit an event in order to check that
 * unchecked changes after the execution of the proxy middlewares
 * have finished.
 */
const proxy_handler = {
  apply: function (target, this_arg, arglist){
    if(!(this_arg.$locals.visited || []).includes(arglist[0]) && arglist.length > 1){//The path has not been visited yet or it is a nested document value
      //Process previously unsaved changes before processing new change
      //See comment on checkUncheckedChanges for a more in-depth explaination
      //as why is this needed
      checkUncheckedChanges.bind(this_arg)();
      const jsonpath = '/' + arglist[0].split('.').filter(p => p).join('/');
      const jsonpath_old_value = getOldValue(this_arg, arglist);
      //We do not transform the possible embeddable document (yet) because the logic is different between them and a plain js object
      const jsonpath_new_value = arglist[1];
      if(!jsonpath_new_value?.$locals){//This is not a Embbeded document
        if((this_arg.$locals.changes || []).every(change => change.path !== jsonpath) && !util.isDeepStrictEqual(jsonpath_old_value, transformToJSObject(jsonpath_new_value))){//The new value is not the same than the old value, so it is an actual change, and there is not yet any change for the given path
          markVisited(this_arg, arglist);
          const change = {path: jsonpath, old_value: jsonpath_old_value};
          if(this_arg.$locals.changes){
            this_arg.$locals.changes.unshift(change); //we insert the changes at the begining of the array because if we have to revert the changes it is not neccesary to revert the array.
          }else{
            this_arg.$locals.changes = [change];
          }
        }
      }else{//This is a embbeded document and we cannot check the new value for the given path, we also have to check that the changed path is not an array because that case is handled earlier.
        if((this_arg.$locals.changes || []).every(change => change.path !== jsonpath)){//There is not any change for this path, so we can introduce it. Otherwise we skip it because if we undo the changes we are going to restore the oldest one.
          markVisited(this_arg, arglist);
          const change = {path: jsonpath, old_value: jsonpath_old_value, unchecked: true};//we are marking the changes that we could not check if they were actual changes, and we will have to check them afterwards
          if(this_arg.$locals.changes){
            this_arg.$locals.changes.unshift(change); //we insert the changes at the begining of the array because if we have to revert the changes it is not neccesary to revert the array.
          }else{
            this_arg.$locals.changes = [change];
          }
        }
      }
    }
    const newtarget = target.bind(this_arg);
    return newtarget(...arglist);
  },
};

const markModifier_proxy= {
  apply: function (target, this_arg, arglist){
    if (!(this_arg.$locals.visited || []).includes(arglist[0])) { //The path has not been visited yet
      markVisited(this_arg, arglist);

      //Process previously unsaved changes before processing new change
      //See comment on checkUncheckedChanges for a more in-depth explaination
      //as why is this needed
      checkUncheckedChanges.bind(this_arg)();
      const jsonpath = '/' + arglist[0].split('.').filter(p => p).join('/');
      const jsonpath_old_value = getOldValue(this_arg, arglist);
      const change = {path: jsonpath, old_value: jsonpath_old_value, unchecked: true};
      if (this_arg.$locals.changes) {
        this_arg.$locals.changes.unshift(change);
      }
    }
    const newtarget = target.bind(this_arg);
    return newtarget(...arglist);
  },
};

const changesTracker = schema => {
  schema.post('init', function(doc){
    const $setProxy = new Proxy(doc.$set, proxy_handler);
    const setProxy = new Proxy(doc.set, proxy_handler);
    const markModifiedProxy = new Proxy(doc.markModified, markModifier_proxy);
    doc.$set = $setProxy; //This is used internally by mongoose.
    doc.set = setProxy; //To intercept the calls when a document is updated using the set method, like myDocument.set('some.path', new_value);
    doc.markModified = markModifiedProxy; //To intercept document updated using the dot notation like myDocument.some.path = new_value;
    doc.$locals.mtcEmitter = new CustomEmmiter();
    doc.$locals.changes = [];
  });

  schema.pre('remove', function(next){
    this.$locals.changes = [{path: '', old_value: this}]
    next();
  });

  /**
   * This method is designed in order to inject the plugin when a model is
   * created using the model's constructor.
   * In Mongoose when a model is created using this way the post-init hook
   * is not called, that's why we have to inject it. We have several ways to
   * inject the plugin, one is to create a pre-save middleware that injects
   * the plugin when the document is new, however we need that this middleware
   * is injected in first place, and we cannot assure that this is gonna happen
   * always.
   * Whit this method we can control when the plugin should be injected.
   */
  schema.methods.injectmtc = function(){
    if(this.isNew){
      const $setProxy = new Proxy(this.$set, proxy_handler);
      const setProxy = new Proxy(this.set, proxy_handler);
      const markModifiedProxy = new Proxy(this.markModified, markModifier_proxy);
      this.$set = $setProxy;
      this.set = setProxy;
      this.markModified = markModifiedProxy;
      this.$locals.changes = [{path: '', old_value: undefined}]
      this.$locals.mtcEmitter = new CustomEmmiter();
    }
  }

  schema.methods.getPreviousValue = function(path = ''){
    if(typeof(path) !== 'string'){
      throw new Error('path must be a string');
    }
    //Process previously unsaved changes before obtaining previous value
    //See comment on checkUncheckedChanges for a more in-depth explaination
    //as why is this needed
    checkUncheckedChanges.bind(this)();
    return previousValue(this, this.$locals.changes, path);
  }

  schema.methods.pathHasChanged = function(path = ''){
    if(typeof(path) !== 'string'){
      throw new Error('path must be a string');
    }
    //Process previously unsaved changes before checking path changes
    //See comment on checkUncheckedChanges for a more in-depth explaination
    //as why is this needed
    checkUncheckedChanges.bind(this)();
    return pathHasChanged(this, this.$locals.changes, path);
  }

  schema.methods.getLocalChanges = function(){
    //Process previously unsaved changes before getting changes
    //See comment on checkUncheckedChanges for a more in-depth explaination
    //as why is this needed
    checkUncheckedChanges.bind(this)();
    return this.$locals.changes;
  }

  /**
   * This methods returns true if the current value for the given path is the
   * same value that the one received by the second arugment, and false if
   * otherwise.
   *
   * @param path: String with the format JSON pointer as defined in RFC6901
   * @param value: Any value
   * returns: Boolean.
   */
  schema.methods.is = function(path = '', value){
    return util.isDeepStrictEqual(getPathValue(this, path), value);
  }

  /**
   * This methods returns true if the previous value for the given path is was
   * the same value that the one received by the second arugment, and false if
   * otherwise.
   *
   * @param path: String with the format JSON pointer as defined in RFC6901
   * @param value: Any value
   * returns: Boolean.
   */
  schema.methods.was = function(path = '', value){
    return util.isDeepStrictEqual(this.getPreviousValue(path), value);
  }

  /**
   * This method returns a new instance of the current model and resets and injects
   * the plugin on the new generated model.
   *
   * This method is useful when you want to do further changes in a model in a
   * post middleware. If you make changes in a post middleware to the already
   * saved model, you will trigger again the pre-middlewares for that model
   * with an extra change made. However if you reacted in the pre-middlewares
   * taking into account the previous changes, then you may activate again
   * the same pre and maybe post middlewares for the given model, creating an
   * infinite loop.
   *
   * However, if you clone the document, then you are not going to repeat the
   * middlewares, but the cloned model must be injected with the plugin
   * in order to be able to register the changes that you have done in the
   * post middleware, and react to that changes in the subsequent pre
   * middlewares, but without taking into account the previous changes
   * already made.
   *
   * @returns: cloned model with the plugin inyected and changes array reset
   */
  schema.methods.clone = function(){
    const new_document = new this.constructor(this);
    const $setProxy = new Proxy(this.$set, proxy_handler);
    const setProxy = new Proxy(this.set, proxy_handler);
    const markModifiedProxy = new Proxy(new_document.markModified, proxy_handler);
    new_document.$set = $setProxy;
    new_document.set = setProxy;
    new_document.markModified = markModifiedProxy;
    new_document.$locals.mtcEmitter = new CustomEmmiter();
    return new_document;
  }
}

module.exports = changesTracker;
