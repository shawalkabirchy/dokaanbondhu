<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Customer;
use App\Models\Payment;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Validator;
use Illuminate\Validation\Rule;

class PaymentController extends Controller
{
    public function store(Request $request)
    {
        $rules = [
            'customer_id' => ['required', 'integer', Rule::exists(Customer::class, 'id')],
            'amount' => 'required|integer|min:1',
            'method' => ['required', Rule::in(['cash', 'bkash', 'nagad'])],
            'trx_id' => ['nullable', 'string', Rule::unique('payments', 'trx_id')->ignore($request->id)],
        ];
        $data = Validator::make($request->all(), $rules)->validate();

        return Payment::create($data);
    }

    public function show(int $payment)
    {
        return Payment::findOrFail($payment);
    }
}
