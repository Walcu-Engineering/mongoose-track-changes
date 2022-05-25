const MONGO_URL = 'mongodb://localhost/mongoose-track-changes';
const mongoose = require('mongoose');
const changesTracker = require('./index'); 

const notificationSchema = mongoose.Schema({
  notify_at: Date,
  notify_to: [{type: mongoose.Schema.Types.ObjectId}],
  done_by: {type: mongoose.Schema.Types.ObjectId},
});

const taskSchema = new mongoose.Schema({
  notification: notificationSchema,
  created_by: {type: mongoose.Schema.Types.ObjectId},
  description: String,
  mixednode: {type: mongoose.Schema.Types.Mixed},
  numbertype: Number,
});

taskSchema.plugin(changesTracker);

test('Mongoose-track-changes', async () => {
  await mongoose.connect(MONGO_URL);
  const taskModel = mongoose.model('Task', taskSchema);
  const task = taskModel({
    notification: {
      notify_at: new Date(),
      notify_to: new Array(3).fill(0).map(() => mongoose.Types.ObjectId()),
      done_by: mongoose.Types.ObjectId(),
    },
    created_by: mongoose.Types.ObjectId(),
    description: 'test',
    numbertype: 3,
    mixednode: {
      depth00: {
        depth10: {
          depth20: 'test',
        },
        depth11: 'test',
      },
    },
  });
  await task.save();
  const saved_task = await mongoose.models.Task.findOne({_id: task._id});
  debugger;
  //const previous_notification = saved_task.getPreviousValue('/notification');//This should return the current saved value
  //const previous_notify_to_without_changes = saved_task.getPreviousValue('/notification/notify_to');//This should return the current saved value
  //saved_task.notification.notify_to[1] = mongoose.Types.ObjectId();
  /*
  saved_task.notification.notify_to = [mongoose.Types.ObjectId()];
  saved_task.notification.notify_to[1] = mongoose.Types.ObjectId();
  saved_task.notification.notify_to[0] = mongoose.Types.ObjectId();
  saved_task.notification.notify_to[1] = mongoose.Types.ObjectId();
  saved_task.notification.notify_to[1] = saved_task.notification.notify_to[1];
  saved_task.notification.notify_to[1] = mongoose.Types.ObjectId();
  saved_task.notification.done_by = mongoose.Types.ObjectId();
  saved_task.description = 'hola';
  saved_task.notification = {
    notify_at: new Date(),
    notify_to: new Array(2).fill(0).map(() => mongoose.Types.ObjectId()),
    done_by: mongoose.Types.ObjectId(),
  };
  */
  saved_task.notification = {
    notify_at: new Date(),
    notify_to: new Array(2).fill(0).map(() => mongoose.Types.ObjectId()),
    done_by: mongoose.Types.ObjectId(),
  };
  saved_task.getPreviousValue('');
  debugger;
});



