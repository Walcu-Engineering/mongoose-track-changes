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
  });
  await task.save();
  const saved_task = await mongoose.models.Task.findOne({});
  debugger;
});



