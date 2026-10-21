<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class PaymentController extends Controller
{
    /** A customer's payment: recorded, and taken off their balance. */
    public function store(Request $request)
    {
        $data = $request->validate([
            'customer_id' => ['required', 'integer', 'exists:parties,party_id'],
            'amount' => ['required', 'integer', 'min:1'],
            'method' => ['required', 'in:cash,bkash'],
        ]);

        return DB::transaction(function () use ($data) {
            $id = DB::table('payments')->insertGetId([
                'party_id' => $data['customer_id'],
                'amount_taka' => $data['amount'],
                'method' => $data['method'],
                'created_at' => now(),
                'updated_at' => now(),
            ]);
            DB::table('parties')->where('party_id', $data['customer_id'])->decrement('balance', $data['amount']);

            return response()->json(['payment' => ['id' => $id, 'amount' => $data['amount']]], 201);
        });
    }
}
