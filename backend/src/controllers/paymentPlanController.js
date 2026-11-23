'use strict';

const PaymentPlan = require('../models/paymentPlanModel');
const Student = require('../models/studentModel');
const { logAudit } = require('../services/auditService');
const Decimal = require('decimal.js');
const { validateDecimalAmount } = require('../utils/decimalPrecision');

async function createPaymentPlan(req, res, next) {
  try {
    const { schoolId } = req;
    const { studentId } = req.params;
    const { installments } = req.body;

    if (!Array.isArray(installments) || installments.length === 0) {
      return res.status(400).json({ error: 'At least one installment is required', code: 'VALIDATION_ERROR' });
    }

    const normalizedInstallments = [];
    for (let index = 0; index < installments.length; index++) {
      const amount = validateDecimalAmount(installments[index]?.amount, { minValue: 0.01 });
      if (!amount.ok) {
        return res.status(400).json({
          error: `Installment ${index + 1}: ${amount.error}`,
          code: amount.code,
          field: `installments.${index}.amount`,
        });
      }
      normalizedInstallments.push({ ...installments[index], amount: amount.value });
    }

    const student = await Student.findOne({ schoolId, studentId });
    if (!student) {
      return res.status(404).json({ error: 'Student not found', code: 'NOT_FOUND' });
    }

    const totalAmount = normalizedInstallments.reduce((sum, installment) => sum.plus(installment.amount), new Decimal(0));

    const plan = await PaymentPlan.create({
      schoolId,
      studentId,
      totalAmount: totalAmount.toNumber(),
      installments: normalizedInstallments.map(inst => ({
        amount: inst.amount.toNumber(),
        dueDate: new Date(inst.dueDate),
        paid: false,
        paidAmount: 0,
      })),
    });

    if (req.auditContext) {
      await logAudit({
        schoolId,
        action: 'payment_plan_create',
        performedBy: req.auditContext.performedBy,
        targetId: studentId,
        targetType: 'payment_plan',
        details: { totalAmount: totalAmount.toString(), installmentCount: installments.length },
        result: 'success',
        ipAddress: req.auditContext.ipAddress,
        userAgent: req.auditContext.userAgent,
      });
    }

    res.status(201).json(plan);
  } catch (err) {
    next(err);
  }
}

async function getPaymentPlan(req, res, next) {
  try {
    const { schoolId } = req;
    const { studentId } = req.params;

    const plan = await PaymentPlan.findOne({ schoolId, studentId, deletedAt: null });
    if (!plan) {
      return res.status(404).json({ error: 'Payment plan not found', code: 'NOT_FOUND' });
    }

    res.json(plan);
  } catch (err) {
    next(err);
  }
}

async function updateInstallmentStatus(req, res, next) {
  try {
    const { schoolId } = req;
    const { studentId, installmentIndex } = req.params;
    const { paid, paidAmount } = req.body;

    const plan = await PaymentPlan.findOne({ schoolId, studentId, deletedAt: null });
    if (!plan) {
      return res.status(404).json({ error: 'Payment plan not found', code: 'NOT_FOUND' });
    }

    if (installmentIndex < 0 || installmentIndex >= plan.installments.length) {
      return res.status(400).json({ error: 'Invalid installment index', code: 'VALIDATION_ERROR' });
    }

    const installment = plan.installments[installmentIndex];
    const normalizedAmount = validateDecimalAmount(paidAmount ?? installment.amount, { currency: 'XLM', minValue: 0 });
    if (!normalizedAmount.ok) {
      return res.status(400).json({ error: normalizedAmount.error, code: normalizedAmount.code, field: 'paidAmount' });
    }
    installment.paid = paid;
    installment.paidAmount = normalizedAmount.value.toNumber();
    if (paid) {
      installment.paidAt = new Date();
    }

    await plan.save();

    if (req.auditContext) {
      await logAudit({
        schoolId,
        action: 'installment_update',
        performedBy: req.auditContext.performedBy,
        targetId: studentId,
        targetType: 'payment_plan',
        details: { installmentIndex, paid, paidAmount },
        result: 'success',
        ipAddress: req.auditContext.ipAddress,
        userAgent: req.auditContext.userAgent,
      });
    }

    res.json(plan);
  } catch (err) {
    next(err);
  }
}

async function cancelPaymentPlan(req, res, next) {
  try {
    const { schoolId } = req;
    const { studentId } = req.params;

    const plan = await PaymentPlan.findOne({ schoolId, studentId, deletedAt: null });
    if (!plan) {
      return res.status(404).json({ error: 'Payment plan not found', code: 'NOT_FOUND' });
    }

    plan.status = 'cancelled';
    plan.deletedAt = new Date();
    await plan.save();

    if (req.auditContext) {
      await logAudit({
        schoolId,
        action: 'payment_plan_cancel',
        performedBy: req.auditContext.performedBy,
        targetId: studentId,
        targetType: 'payment_plan',
        details: {},
        result: 'success',
        ipAddress: req.auditContext.ipAddress,
        userAgent: req.auditContext.userAgent,
      });
    }

    res.json({ message: 'Payment plan cancelled' });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  createPaymentPlan,
  getPaymentPlan,
  updateInstallmentStatus,
  cancelPaymentPlan,
};
