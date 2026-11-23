'use strict';

const mongoose = require('mongoose');

const dataDeletionCertificateSchema = new mongoose.Schema({
  category: { type: String, required: true, maxlength: 64 },
  recordId: { type: String, required: true, maxlength: 128 },
  schoolId: { type: String, default: null, maxlength: 128 },
  purgedAt: { type: Date, required: true },
  performedBy: { type: String, required: true, maxlength: 128 },
}, { timestamps: true, versionKey: false });

dataDeletionCertificateSchema.index({ category: 1, recordId: 1 }, { unique: true });

dataDeletionCertificateSchema.pre(
  ['updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'findOneAndUpdate', 'findOneAndDelete', 'replaceOne'],
  function preventCertificateMutation() {
    throw new Error('Deletion certificates are immutable');
  },
);

dataDeletionCertificateSchema.pre('save', function preventCertificateResave() {
  if (!this.isNew) throw new Error('Deletion certificates are immutable');
});

module.exports = mongoose.model('DataDeletionCertificate', dataDeletionCertificateSchema);
